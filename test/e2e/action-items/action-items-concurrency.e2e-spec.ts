import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { actionItems, organizationMembers } from '../../../src/infra/database/schema/index.js';
import { ActionItemsRepository } from '../../../src/modules/action-items/action-items.repository.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** Hai người sửa cùng lúc / người được giao rời org (M12 B5). */
describe('Action items — đồng thời (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let author: TestUser;
  let assignee: TestUser;
  let meetingId: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, author, assignee] = (await Promise.all(
      Array.from({ length: 3 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Đồng thời' }).expect(201))
      .body.data.id as string;
    await addMember(db, orgId, author.id);
    await addMember(db, orgId, assignee.id);
    const pub = await insertChannel(db, orgId, owner.id, { visibility: 'public' });
    meetingId = (await insertMeeting(db, orgId, author.id, { status: 'completed' })).id;
    await shareMeeting(db, orgId, meetingId, pub.id, author.id);
  });

  afterAll(async () => {
    await app.close();
  });

  async function newItem(over: Partial<typeof actionItems.$inferInsert> = {}) {
    const [row] = await db
      .insert(actionItems)
      .values({ orgId, meetingId, origin: 'manual', task: 'gốc', ...over })
      .returning();
    return row!;
  }
  const patch = (u: TestUser, id: string, body: object, version: number) =>
    http()
      .patch(`/v1/orgs/${orgId}/action-items/${id}`)
      .set(as(u))
      .set('If-Match', `"${version}"`)
      .send(body);
  const rowOf = async (id: string) =>
    (await db.select().from(actionItems).where(eq(actionItems.id, id)))[0]!;

  // Đột biến: bỏ `eq(actionItems.version, expectedVersion)` khỏi WHERE của updateIfVersion → cả 6 đều 200.
  it('6 PATCH song song cùng version → đúng MỘT thành công, 5 còn lại 412; version +1; ghi của người thắng', async () => {
    const item = await newItem();
    const tasks = Array.from({ length: 6 }, (_, i) => `bản ${i}`);
    const results = await Promise.all(tasks.map((task) => patch(author, item.id, { task }, 1)));
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 412, 412, 412, 412, 412]);
    const winner = results.find((r) => r.status === 200)!;
    const row = await rowOf(item.id);
    expect(row.version).toBe(2);
    expect(row.task).toBe(winner.body.data.task);
    expect(
      results
        .filter((r) => r.status === 412)
        .every((r) => r.body.error.code === 'ACTION_ITEM_VERSION_MISMATCH'),
    ).toBe(true);
  });

  it('chủ bỏ việc trong lúc người được giao đóng nó (cùng version) → đúng một thắng, trạng thái cuối khớp người thắng', async () => {
    for (let round = 0; round < 5; round++) {
      const item = await newItem({ assigneeId: assignee.id });
      const [byAuthor, byAssignee] = await Promise.all([
        patch(author, item.id, { status: 'dismissed' }, 1),
        patch(assignee, item.id, { status: 'done' }, 1),
      ]);
      expect([byAuthor.status, byAssignee.status].sort((a, b) => a - b)).toEqual([200, 412]);
      const row = await rowOf(item.id);
      expect(row.status).toBe(byAuthor.status === 200 ? 'dismissed' : 'done');
      // CHECK completed_ck: done ⇔ có completed_at (không bao giờ ở trạng thái lai)
      expect(row.completedAt !== null).toBe(row.status === 'done');
    }
  });

  it('chủ đổi người được giao trong lúc người cũ đóng việc (cùng version) → đúng một thắng', async () => {
    const item = await newItem({ assigneeId: assignee.id });
    const [reassign, close] = await Promise.all([
      patch(author, item.id, { assigneeId: null }, 1),
      patch(assignee, item.id, { status: 'done' }, 1),
    ]);
    expect([reassign.status, close.status].sort((a, b) => a - b)).toEqual([200, 412]);
  });

  it('người được giao rời org → assignee_id NULL (org_id nguyên), version KHÔNG đổi, PATCH tiếp bằng If-Match hiện tại vẫn chạy', async () => {
    const leaver = await registerUser(app);
    await addMember(db, orgId, leaver.id);
    const item = await newItem({ assigneeId: leaver.id });
    await db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, leaver.id)));
    const after = await rowOf(item.id);
    expect(after).toMatchObject({ assigneeId: null, orgId, version: 1 });

    const res = await patch(author, item.id, { task: 'sau khi người đó rời' }, 1).expect(200);
    expect(res.body.data).toMatchObject({
      assignee: null,
      version: 2,
      task: 'sau khi người đó rời',
    });
  });

  it('người được giao đã rời org không còn là người được giao → không đóng được việc (403)', async () => {
    const leaver = await registerUser(app);
    await addMember(db, orgId, leaver.id);
    const item = await newItem({ assigneeId: leaver.id });
    await db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, leaver.id)));
    // leaver không còn là thành viên → 404 từ OrgMemberGuard; một member khác không phải người được giao → 403
    await patch(leaver, item.id, { status: 'done' }, 1).expect(404);
    await patch(assignee, item.id, { status: 'done' }, 1).expect(403);
    expect(await rowOf(item.id)).toMatchObject({ status: 'open', assigneeId: null, version: 1 });
  });

  // Race thật khó dựng bằng HTTP (cửa sổ giữa kiểm và ghi chỉ vài ms) → giả lập: ép bước kiểm trả "được"
  // như thể người đó còn là thành viên lúc kiểm, rồi đã rời trước lúc ghi. Chỉ composite FK còn chặn.
  // Đột biến: bỏ `guardAssigneeFk` → 409 `CONFLICT` chung thay vì 422 `ACTION_ITEM_ASSIGNEE_INVALID`.
  it('giao cho người đã rời org giữa lúc kiểm và lúc ghi: FK chặn → 422, không để lại tham chiếu treo', async () => {
    const ghost = await registerUser(app); // không phải thành viên org
    const spy = vi.spyOn(app.get(ActionItemsRepository), 'canBeAssigned').mockResolvedValue(true);
    try {
      const item = await newItem();
      const res = await patch(author, item.id, { assigneeId: ghost.id }, 1).expect(422);
      expect(res.body.error.code).toBe('ACTION_ITEM_ASSIGNEE_INVALID');
      expect(await rowOf(item.id)).toMatchObject({ assigneeId: null, version: 1 });

      const created = await http()
        .post(`/v1/orgs/${orgId}/meetings/${meetingId}/action-items`)
        .set(as(author))
        .send({ task: 'x', assigneeId: ghost.id })
        .expect(422);
      expect(created.body.error.code).toBe('ACTION_ITEM_ASSIGNEE_INVALID');
    } finally {
      spy.mockRestore();
    }
  });
});
