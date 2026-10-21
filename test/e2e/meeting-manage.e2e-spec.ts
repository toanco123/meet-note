import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { auditLogs } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addMember, insertChannel, insertMeeting, shareMeeting } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Meetings: sửa / xoá (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let author: TestUser;
  let outsider: TestUser;
  let pub: string;

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const url = (id: string) => `/v1/orgs/${orgId}/meetings/${id}`;
  const patch = (who: TestUser, id: string, body: object) =>
    http().patch(url(id)).set(as(who)).send(body);
  const remove = (who: TestUser, id: string) => http().delete(url(id)).set(as(who));
  const outcome = (r: request.Response) =>
    r.status < 300 ? r.status : `${r.status} ${r.body.error.code}`;
  /** Meeting của `author`, share vào kênh công khai → `outsider` XEM được nhưng không quản lý được. */
  const authorsInPublic = async () => {
    const id = (await insertMeeting(db, orgId, author.id)).id;
    await shareMeeting(db, orgId, id, pub, author.id);
    return id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    const users: TestUser[] = [];
    for (let i = 0; i < 4; i++) users.push(await registerUser(app));
    [owner, orgAdmin, author, outsider] = users as [TestUser, TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Sửa' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    await addMember(db, orgId, author.id);
    await addMember(db, orgId, outsider.id);
    pub = (await insertChannel(db, orgId, author.id, { visibility: 'public' })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('chủ sửa tiêu đề (trim) + thời điểm họp; body rỗng → 200 không đổi; dữ liệu sai → 400', async () => {
    const id = await authorsInPublic();
    const res = await patch(author, id, {
      title: '  Họp tổng kết  ',
      recordedAt: '2026-10-20T02:00:00.000Z',
    }).expect(200);
    const empty = await patch(author, id, {}).expect(200);

    expect([res.body.data.title, res.body.data.recordedAt, empty.body.data.title]).toEqual([
      'Họp tổng kết',
      '2026-10-20T02:00:00.000Z',
      'Họp tổng kết',
    ]);
    expect(
      await Promise.all(
        [{ title: '   ' }, { recordedAt: 'hôm qua' }, { ownerId: author.id }].map(async (b) =>
          outcome(await patch(author, id, b)),
        ),
      ),
    ).toEqual(['400 VALIDATION_FAILED', '400 VALIDATION_FAILED', '400 VALIDATION_FAILED']);
  });

  it('ma trận quyền sửa: xem được mà không có quyền → 403, không xem được → 404, OrgAdm chỉ với meeting không chủ', async () => {
    const visibleToOutsider = await authorsInPublic();
    const hidden = (await insertMeeting(db, orgId, author.id)).id;
    const orphan = (await insertMeeting(db, orgId, null)).id;
    const cases: Array<[string, TestUser, string, string | number]> = [
      [
        'người ngoài, meeting thấy được qua kênh công khai',
        outsider,
        visibleToOutsider,
        '403 FORBIDDEN',
      ],
      ['người ngoài, meeting không thấy được', outsider, hidden, '404 NOT_FOUND'],
      [
        'Admin org, meeting có chủ (thấy được qua kênh công khai)',
        orgAdmin,
        visibleToOutsider,
        '403 FORBIDDEN',
      ],
      ['Admin org, meeting có chủ, không thấy được', orgAdmin, hidden, '404 NOT_FOUND'],
      ['Admin org, meeting không chủ (Q2)', orgAdmin, orphan, 200],
      ['thành viên, meeting không chủ', outsider, orphan, '404 NOT_FOUND'],
    ];
    const results: Array<[string, string | number]> = [];
    for (const [label, who, id] of cases) {
      results.push([label, outcome(await patch(who, id, { title: 'Đổi' }))]);
    }
    expect(results).toEqual(cases.map(([label, , , expected]) => [label, expected]));
  });

  it('xoá: 204 → biến mất khỏi chi tiết, danh sách, kênh; gọi lại → 404; chủ tự xoá không ghi audit', async () => {
    const id = await authorsInPublic();
    await remove(author, id).expect(204);

    const [detail, mine, inChannel, again] = await Promise.all([
      http().get(url(id)).set(as(author)),
      http().get(`/v1/orgs/${orgId}/meetings`).set(as(author)),
      http().get(`/v1/orgs/${orgId}/channels/${pub}/meetings`).set(as(outsider)),
      remove(author, id),
    ]);
    const has = (r: request.Response) =>
      (r.body.data as Array<{ id: string }>).some((m) => m.id === id);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, id));
    expect([detail.status, has(mine), has(inChannel), outcome(again), audits.length]).toEqual([
      404,
      false,
      false,
      '404 NOT_FOUND',
      0,
    ]);
  });

  it('Admin org xoá meeting KHÔNG chủ → 204 + audit `meeting.deleted` (thao tác quản trị)', async () => {
    const orphan = (await insertMeeting(db, orgId, null, { title: 'Họp mồ côi' })).id;
    await remove(orgAdmin, orphan).expect(204);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetId, orphan), eq(auditLogs.action, 'meeting.deleted')));
    expect([log?.actorId, log?.targetType, log?.metadata]).toEqual([
      orgAdmin.id,
      'meeting',
      { before: { title: 'Họp mồ côi', ownerId: null } },
    ]);
  });
});
