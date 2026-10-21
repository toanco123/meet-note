import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../../src/common/pagination/cursor.js';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { createTestApp } from '../../support/app.js';
import { addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

interface LogBody {
  id: number;
  action: string;
  actorId: string | null;
  actorDisplayName: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

describe('GET /v1/orgs/:orgId/audit-logs (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const logs = (query: Record<string, string | number> = {}, who: TestUser = owner) =>
    http().get(`/v1/orgs/${orgId}/audit-logs`).query(query).set(as(who));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, admin, member] = await Promise.all([
      registerUser(app, { displayName: 'Chủ Audit' }),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Audit' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');

    // Chuỗi thao tác quản trị → 1 + 1 + 3 + 1 = 6 dòng audit (kể cả org.created).
    await http().patch(`/v1/orgs/${orgId}`).set(as(owner)).send({ name: 'Audit 2' }).expect(200);
    for (let i = 0; i < 3; i++) {
      await http().post(`/v1/orgs/${orgId}/invites`).set(as(admin)).send({}).expect(201);
    }
    await http()
      .patch(`/v1/orgs/${orgId}/members/${member.id}`)
      .set(as(owner))
      .send({ role: 'admin' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('mới nhất trước; có tên người thực hiện; ghi đủ thao tác của M2 + M3', async () => {
    const res = await logs({ limit: 100 }).expect(200);
    const data = res.body.data as LogBody[];

    expect(data.map((l) => l.action)).toEqual([
      'org.member.role_changed',
      'org.invite.created',
      'org.invite.created',
      'org.invite.created',
      'org.updated',
      'org.created',
    ]);
    expect(data[0]).toMatchObject({
      actorId: owner.id,
      actorDisplayName: 'Chủ Audit',
      metadata: { before: { role: 'member' }, after: { role: 'admin' } },
    });
    const times = data.map((l) => Date.parse(l.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('lọc theo action và actorId', async () => {
    const byAction = await logs({ action: 'org.invite.created' }).expect(200);
    expect(byAction.body.data).toHaveLength(3);

    const byActor = await logs({ actorId: admin.id }).expect(200);
    expect(new Set((byActor.body.data as LogBody[]).map((l) => l.actorId))).toEqual(
      new Set([admin.id]),
    );
  });

  it('phân trang bằng cursor (khoá thứ hai là id bigint): không trùng, không sót', async () => {
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { data: LogBody[]; meta: { nextCursor: string | null } } } = await logs(
        cursor ? { limit: 2, cursor } : { limit: 2 },
      ).expect(200);
      ids.push(...res.body.data.map((l) => l.id));
      cursor = res.body.meta.nextCursor;
    } while (cursor);

    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it.each([
    ['id là chuỗi', encodeCursor(['2026-10-13T00:00:00.000000Z', 'abc'])],
    ['id âm', encodeCursor(['2026-10-13T00:00:00.000000Z', -1])],
    ['id số thực', encodeCursor(['2026-10-13T00:00:00.000000Z', 1.5])],
  ])('cursor bị sửa tay (%s) → 400 INVALID_CURSOR', async (_label, cursor) => {
    const res = await logs({ cursor }).expect(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('action không thuộc danh sách → 400', async () => {
    const res = await logs({ action: 'org.hacked' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('member → 403', async () => {
    const res = await logs(
      {},
      await (async () => {
        const m = await registerUser(app);
        await addMember(db, orgId, m.id, 'member');
        return m;
      })(),
    ).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});
