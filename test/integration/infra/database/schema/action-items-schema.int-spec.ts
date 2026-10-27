import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  actionItems,
  meetings,
  organizationMembers,
} from '../../../../../src/infra/database/schema/index.js';
import {
  addMember,
  insertMeeting,
  insertOrg,
  insertUser,
} from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}
const codeAndConstraint = async (p: Promise<unknown>) => {
  const e = await pgErrorOf(p);
  return [e?.code, e?.constraint];
};

/** Bất biến của bảng `action_items` (M12 B1): CHECK, khoá tự nhiên của việc AI, FK, RLS. */
describe('Schema action_items (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb(); // user worker (BYPASSRLS) — dựng dữ liệu như pipeline
  });

  afterAll(async () => {
    await t.close();
  });

  async function meetingInNewOrg() {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const meeting = await insertMeeting(t.db, org.id, owner.id);
    return { orgId: org.id, meetingId: meeting.id, ownerId: owner.id };
  }
  const item = (
    m: { orgId: string; meetingId: string },
    over: Partial<typeof actionItems.$inferInsert> = {},
  ) =>
    t.db
      .insert(actionItems)
      .values({
        orgId: m.orgId,
        meetingId: m.meetingId,
        origin: 'ai',
        sourceIndex: 0,
        task: 'Gửi báo giá',
        ...over,
      })
      .returning();

  it('mặc định: open, version 1, chưa hoàn thành; id uuidv7', async () => {
    const m = await meetingInNewOrg();
    const [row] = await item(m);
    expect(row).toMatchObject({
      status: 'open',
      version: 1,
      completedAt: null,
      assigneeId: null,
      dueDate: null,
    });
    expect(row!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('CHECK: status / origin lạ, version 0, task rỗng / quá 500, owner_name / due_text rỗng → 23514 đúng tên', async () => {
    const m = await meetingInNewOrg();
    const results = [
      await codeAndConstraint(item(m, { status: 'x' as never })),
      await codeAndConstraint(item(m, { origin: 'x' as never, sourceIndex: null })),
      await codeAndConstraint(item(m, { version: 0 })),
      await codeAndConstraint(item(m, { task: '' })),
      await codeAndConstraint(item(m, { task: 'a'.repeat(501) })),
      await codeAndConstraint(item(m, { ownerName: '' })),
      await codeAndConstraint(item(m, { dueText: '' })),
    ];
    expect(results).toEqual([
      ['23514', 'action_items_status_ck'],
      ['23514', 'action_items_origin_ck'],
      ['23514', 'action_items_version_ck'],
      ['23514', 'action_items_task_length_ck'],
      ['23514', 'action_items_task_length_ck'],
      ['23514', 'action_items_owner_name_length_ck'],
      ['23514', 'action_items_due_text_length_ck'],
    ]);
    expect((await item(m, { task: 'a'.repeat(500) })).length).toBe(1); // biên 500 hợp lệ
  });

  it('action_items_source_ck: AI phải có source_index ≥ 0; manual phải KHÔNG có', async () => {
    const m = await meetingInNewOrg();
    expect([
      await codeAndConstraint(item(m, { origin: 'ai', sourceIndex: null })),
      await codeAndConstraint(item(m, { origin: 'ai', sourceIndex: -1 })),
      await codeAndConstraint(item(m, { origin: 'manual', sourceIndex: 0 })),
    ]).toEqual([
      ['23514', 'action_items_source_ck'],
      ['23514', 'action_items_source_ck'],
      ['23514', 'action_items_source_ck'],
    ]);
    expect((await item(m, { origin: 'manual', sourceIndex: null })).length).toBe(1);
  });

  it('action_items_completed_ck: done ⇔ có completed_at', async () => {
    const m = await meetingInNewOrg();
    expect([
      await codeAndConstraint(item(m, { status: 'done', completedAt: null })),
      await codeAndConstraint(item(m, { status: 'open', completedAt: new Date() })),
      await codeAndConstraint(item(m, { status: 'dismissed', completedAt: new Date() })),
    ]).toEqual([
      ['23514', 'action_items_completed_ck'],
      ['23514', 'action_items_completed_ck'],
      ['23514', 'action_items_completed_ck'],
    ]);
    expect((await item(m, { status: 'done', completedAt: new Date() })).length).toBe(1);
  });

  // Đột biến: bỏ `WHERE origin = 'ai'` khỏi unique → hai việc thủ công (source_index NULL) vẫn hợp lệ
  // (NULL ≠ NULL), nhưng đổi sang unique thường thì việc AI vẫn bị chặn: kiểm đủ hai chiều.
  it('action_items_ai_source_uq: trùng (meeting, source_index) của việc AI → 23505; việc thủ công không bị', async () => {
    const m = await meetingInNewOrg();
    const other = await meetingInNewOrg();
    await item(m, { sourceIndex: 0 });
    expect(await codeAndConstraint(item(m, { sourceIndex: 0 }))).toEqual([
      '23505',
      'action_items_ai_source_uq',
    ]);
    expect((await item(m, { sourceIndex: 1 })).length).toBe(1); // vị trí khác
    expect((await item(other, { sourceIndex: 0 })).length).toBe(1); // meeting khác
    await item(m, { origin: 'manual', sourceIndex: null });
    await item(m, { origin: 'manual', sourceIndex: null }); // nhiều việc thủ công
    expect(
      (await t.db.select().from(actionItems).where(eq(actionItems.meetingId, m.meetingId))).length,
    ).toBe(4);
  });

  it('composite FK meeting: org_id không khớp meeting → 23503; xoá meeting → việc đi theo (CASCADE)', async () => {
    const a = await meetingInNewOrg();
    const b = await meetingInNewOrg();
    expect(await codeAndConstraint(item({ orgId: b.orgId, meetingId: a.meetingId }))).toEqual([
      '23503',
      'action_items_meeting_fk',
    ]);
    await item(a);
    await t.db.delete(meetings).where(eq(meetings.id, a.meetingId));
    expect(
      await t.db.select().from(actionItems).where(eq(actionItems.meetingId, a.meetingId)),
    ).toEqual([]);
  });

  // Đột biến: FK assignee dùng `ON DELETE SET NULL` (cả hai cột) → gỡ thành viên lỗi 23502.
  it('assignee: phải là thành viên CÙNG org (23503); gỡ thành viên → assignee_id NULL, org_id & việc còn nguyên', async () => {
    const m = await meetingInNewOrg();
    const outsider = await insertUser(t.db);
    expect(await codeAndConstraint(item(m, { assigneeId: outsider.id }))).toEqual([
      '23503',
      'action_items_assignee_fk',
    ]);
    const member = await insertUser(t.db);
    await addMember(t.db, m.orgId, member.id);
    const [row] = await item(m, { assigneeId: member.id, task: 'việc của thành viên' });
    await t.db.delete(organizationMembers).where(eq(organizationMembers.userId, member.id));
    const [after] = await t.db.select().from(actionItems).where(eq(actionItems.id, row!.id));
    expect(after).toMatchObject({ assigneeId: null, orgId: m.orgId, task: 'việc của thành viên' });
  });

  it('xoá người hoàn thành / người tạo → cột về NULL, việc còn', async () => {
    const m = await meetingInNewOrg();
    const user = await insertUser(t.db);
    const [row] = await item(m, {
      origin: 'manual',
      sourceIndex: null,
      status: 'done',
      completedAt: new Date(),
      completedBy: user.id,
      createdBy: user.id,
    });
    await t.db.execute(sql`delete from users where id = ${user.id}`);
    const [after] = await t.db.select().from(actionItems).where(eq(actionItems.id, row!.id));
    expect(after).toMatchObject({ completedBy: null, createdBy: null, status: 'done' });
  });

  // Đột biến: bỏ policy `action_items_org_isolation` → user api thấy việc của tổ chức khác.
  it('RLS: user của api không ngữ cảnh / khác tổ chức không thấy; đúng tổ chức thấy; ghi sai tổ chức bị chặn', async () => {
    const [a, other] = [await meetingInNewOrg(), await meetingInNewOrg()];
    const [row] = await item(a);
    const api = createTestDb(1, process.env.DATABASE_URL); // max 1 → set_config áp cho câu sau
    try {
      const count = async (orgId: string) => {
        await api.db.execute(sql`select set_config('app.org_id', ${orgId}, false)`);
        return (
          await api.db
            .select({ id: actionItems.id })
            .from(actionItems)
            .where(eq(actionItems.id, row!.id))
        ).length;
      };
      expect([await count(''), await count(other.orgId), await count(a.orgId)]).toEqual([0, 0, 1]);
      await api.db.execute(sql`select set_config('app.org_id', ${other.orgId}, false)`);
      const e = await pgErrorOf(
        api.db.insert(actionItems).values({
          orgId: a.orgId,
          meetingId: a.meetingId,
          origin: 'manual',
          task: 'ghi chéo tổ chức',
        }),
      );
      expect(e?.code).toBe('42501');
    } finally {
      await api.close();
    }
  });
});
