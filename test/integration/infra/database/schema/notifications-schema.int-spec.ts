import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  notifications,
  organizationMembers,
} from '../../../../../src/infra/database/schema/index.js';
import { addMember, insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

/** Bất biến của `notifications` mà DB tự giữ (M10 B1). */
describe('Schema notifications (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  const note = (
    userId: string,
    over: Partial<typeof notifications.$inferInsert> = {},
  ): typeof notifications.$inferInsert => ({
    userId,
    type: 'channel.member_added',
    payload: { channelId: 'c1', channelName: 'Kênh' },
    ...over,
  });

  it('dedupe: cùng người + cùng khoá → 23505; khoá NULL không đụng nhau; người khác cùng khoá thì được', async () => {
    const [a, b] = [await insertUser(t.db), await insertUser(t.db)];
    await t.db.insert(notifications).values(note(a.id, { dedupeKey: 'k1' }));

    const dup = await pgErrorOf(t.db.insert(notifications).values(note(a.id, { dedupeKey: 'k1' })));
    await t.db.insert(notifications).values([note(a.id), note(a.id)]); // NULL, NULL
    await t.db.insert(notifications).values(note(b.id, { dedupeKey: 'k1' }));

    expect([dup?.code, dup?.constraint]).toEqual(['23505', 'notifications_user_dedupe_uq']);
  });

  it('loại thông báo ngoài danh sách → CHECK 23514', async () => {
    const a = await insertUser(t.db);
    const error = await pgErrorOf(
      t.db.insert(notifications).values(note(a.id, { type: 'hack' as never })),
    );
    expect([error?.code, error?.constraint]).toEqual(['23514', 'notifications_type_ck']);
  });

  it('thông báo của tổ chức mà người nhận KHÔNG thuộc → FK 23503', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const outsider = await insertUser(t.db);

    const error = await pgErrorOf(
      t.db.insert(notifications).values(note(outsider.id, { orgId: org.id })),
    );

    expect([error?.code, error?.constraint]).toEqual(['23503', 'notifications_org_member_fk']);
  });

  it('rời / bị gỡ khỏi tổ chức → thông báo của tổ chức ĐÓ bị xoá theo; tổ chức khác + không thuộc tổ chức vẫn còn (Q3)', async () => {
    const owner = await insertUser(t.db);
    const [orgA, orgB] = [await insertOrg(t.db, owner.id), await insertOrg(t.db, owner.id)];
    const member = await insertUser(t.db);
    await addMember(t.db, orgA.id, member.id);
    await addMember(t.db, orgB.id, member.id);
    await t.db
      .insert(notifications)
      .values([
        note(member.id, { orgId: orgA.id, dedupeKey: 'a' }),
        note(member.id, { orgId: orgB.id, dedupeKey: 'b' }),
        note(member.id, { dedupeKey: 'none' }),
      ]);

    await t.db
      .delete(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgA.id), eq(organizationMembers.userId, member.id)),
      );

    const left = await t.db
      .select({ key: notifications.dedupeKey })
      .from(notifications)
      .where(eq(notifications.userId, member.id));
    expect(left.map((r) => r.key).sort()).toEqual(['b', 'none']);
  });

  it('đếm chưa đọc DÙNG ĐƯỢC index partial `notifications_user_unread_idx`', async () => {
    const a = await insertUser(t.db);
    const plan = await t.db.transaction(async (tx) => {
      // Ít dòng thì planner luôn chọn seq scan → tắt để hỏi "index có dùng được không", không đo tốc độ.
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`explain
        select count(*) from ${notifications}
        where ${notifications.userId} = ${a.id} and ${notifications.readAt} is null
          and ${notifications.deletedAt} is null`);
    });
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'notifications_user_unread_idx',
    );
  });
});
