import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { actionItems } from '../../../../src/infra/database/schema/index.js';
import { ActionItemsRepository } from '../../../../src/modules/action-items/action-items.repository.js';
import type { NewAiActionItem } from '../../../../src/modules/action-items/action-items.types.js';
import { addMember, insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const ai = (sourceIndex: number, over: Partial<NewAiActionItem> = {}): NewAiActionItem => ({
  sourceIndex,
  task: `Việc ${sourceIndex}`,
  ownerName: null,
  assigneeId: null,
  dueText: null,
  dueDate: null,
  ...over,
});

/** `ActionItemsRepository` (M12 B1): idempotency của việc AI và khoá lạc quan, trên Postgres thật. */
describe('ActionItemsRepository (Postgres thật)', () => {
  let t: TestDb;
  let repo: ActionItemsRepository;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb();
    repo = new ActionItemsRepository(t.db);
    userId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, userId)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  const newMeeting = async () => ({ id: (await insertMeeting(t.db, orgId, userId)).id, orgId });

  describe('insertAiIfAbsent', () => {
    it('chèn đủ, trả số dòng chèn; danh sách theo thứ tự tạo', async () => {
      const m = await newMeeting();
      expect(await repo.insertAiIfAbsent(m, [ai(0), ai(1), ai(2)])).toBe(3);
      const rows = await repo.listByMeeting(m.id);
      expect(rows.map((r) => [r.sourceIndex, r.origin, r.status])).toEqual([
        [0, 'ai', 'open'],
        [1, 'ai', 'open'],
        [2, 'ai', 'open'],
      ]);
    });

    it('danh sách rỗng → 0, không lỗi', async () => {
      expect(await repo.insertAiIfAbsent(await newMeeting(), [])).toBe(0);
    });

    // Đột biến: bỏ `onConflictDoNothing` → lần hai lỗi 23505; đổi sang DoUpdate → test "không đè" đỏ.
    it('chạy HAI lần cùng đầu vào → không trùng, lần hai chèn 0', async () => {
      const m = await newMeeting();
      await repo.insertAiIfAbsent(m, [ai(0), ai(1)]);
      expect(await repo.insertAiIfAbsent(m, [ai(0), ai(1)])).toBe(0);
      expect(await repo.listByMeeting(m.id)).toHaveLength(2);
    });

    it('KHÔNG đè việc đã sửa / đã done: lần chạy lại với nội dung khác vẫn giữ bản của người', async () => {
      const m = await newMeeting();
      await repo.insertAiIfAbsent(m, [ai(0, { task: 'Bản máy' }), ai(1, { task: 'Việc hai' })]);
      const [first, second] = await repo.listByMeeting(m.id);
      await repo.updateIfVersion(first!.id, 1, { task: 'Bản người sửa' }, userId);
      await repo.updateIfVersion(second!.id, 1, { status: 'done' }, userId);

      const inserted = await repo.insertAiIfAbsent(m, [
        ai(0, { task: 'Máy trả khác lần hai' }),
        ai(1, { task: 'Máy trả khác lần hai' }),
        ai(2, { task: 'Việc mới thêm' }),
      ]);
      expect(inserted).toBe(1); // chỉ vị trí 2 là mới
      const rows = await repo.listByMeeting(m.id);
      expect(rows.map((r) => [r.task, r.status, r.version])).toEqual([
        ['Bản người sửa', 'open', 2],
        ['Việc hai', 'done', 2],
        ['Việc mới thêm', 'open', 1],
      ]);
    });

    it('việc đã dismissed không bị chèn lại (tombstone thay cho DELETE)', async () => {
      const m = await newMeeting();
      await repo.insertAiIfAbsent(m, [ai(0)]);
      const [row] = await repo.listByMeeting(m.id);
      await repo.updateIfVersion(row!.id, 1, { status: 'dismissed' }, userId);
      expect(await repo.insertAiIfAbsent(m, [ai(0)])).toBe(0);
      expect((await repo.listByMeeting(m.id)).map((r) => r.status)).toEqual(['dismissed']);
    });

    it('hai lần chèn SONG SONG cùng việc → đúng một bộ', async () => {
      const m = await newMeeting();
      const counts = await Promise.all(
        Array.from({ length: 6 }, () => repo.insertAiIfAbsent(m, [ai(0), ai(1), ai(2)])),
      );
      expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
      expect(await repo.listByMeeting(m.id)).toHaveLength(3);
    });

    it('trong transaction rollback → không để lại việc mồ côi', async () => {
      const m = await newMeeting();
      await expect(
        t.db.transaction(async (tx) => {
          await repo.insertAiIfAbsent(m, [ai(0)], tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await repo.listByMeeting(m.id)).toEqual([]);
    });

    it('lưu đủ trường: người phụ trách đã map, hạn chữ và ngày', async () => {
      const m = await newMeeting();
      const member = await insertUser(t.db);
      await addMember(t.db, orgId, member.id);
      await repo.insertAiIfAbsent(m, [
        ai(0, {
          ownerName: 'Bình',
          assigneeId: member.id,
          dueText: 'thứ sáu',
          dueDate: '2026-10-30',
        }),
      ]);
      const [row] = await repo.listByMeeting(m.id);
      expect(row).toMatchObject({
        ownerName: 'Bình',
        assigneeId: member.id,
        dueText: 'thứ sáu',
        dueDate: '2026-10-30',
      });
    });
  });

  describe('updateIfVersion', () => {
    async function oneItem(over: Partial<NewAiActionItem> = {}) {
      const m = await newMeeting();
      await repo.insertAiIfAbsent(m, [ai(0, over)]);
      return (await repo.listByMeeting(m.id))[0]!;
    }

    it('đúng version → áp patch, version + 1, field khác nguyên', async () => {
      const row = await oneItem({ ownerName: 'Bình', dueText: 'thứ sáu', dueDate: '2026-10-30' });
      const out = await repo.updateIfVersion(row.id, 1, { task: 'Việc mới' }, userId);
      expect(out.kind).toBe('updated');
      if (out.kind !== 'updated') return;
      expect(out.item).toMatchObject({
        task: 'Việc mới',
        version: 2,
        ownerName: 'Bình',
        dueText: 'thứ sáu',
        dueDate: '2026-10-30',
        status: 'open',
      });
    });

    it('sai version → version_mismatch kèm version hiện tại, dữ liệu nguyên; id lạ → not_found', async () => {
      const row = await oneItem();
      await repo.updateIfVersion(row.id, 1, { task: 'b' }, userId);
      expect(await repo.updateIfVersion(row.id, 1, { task: 'ghi đè mù' }, userId)).toEqual({
        kind: 'version_mismatch',
        currentVersion: 2,
      });
      expect(
        await repo.updateIfVersion(
          '01a16185-7123-7052-b52a-dfddd7dfb0db',
          1,
          { task: 'x' },
          userId,
        ),
      ).toEqual({ kind: 'not_found' });
      const [after] = await t.db.select().from(actionItems).where(eq(actionItems.id, row.id));
      expect(after).toMatchObject({ task: 'b', version: 2 });
    });

    it('sang done → đặt completed_at / completed_by; về open → xoá cả hai', async () => {
      const row = await oneItem();
      const done = await repo.updateIfVersion(row.id, 1, { status: 'done' }, userId);
      if (done.kind !== 'updated') throw new Error('kỳ vọng updated');
      expect(done.item.completedAt).toBeInstanceOf(Date);
      expect(done.item.completedBy).toBe(userId);
      const reopened = await repo.updateIfVersion(row.id, 2, { status: 'open' }, userId);
      if (reopened.kind !== 'updated') throw new Error('kỳ vọng updated');
      expect([reopened.item.status, reopened.item.completedAt, reopened.item.completedBy]).toEqual([
        'open',
        null,
        null,
      ]);
    });

    it('đã done mà đặt done lần nữa → GIỮ người và lúc hoàn thành đầu tiên', async () => {
      const row = await oneItem();
      const other = await insertUser(t.db);
      await addMember(t.db, orgId, other.id);
      const first = await repo.updateIfVersion(row.id, 1, { status: 'done' }, userId);
      const again = await repo.updateIfVersion(row.id, 2, { status: 'done' }, other.id);
      if (first.kind !== 'updated' || again.kind !== 'updated') throw new Error('kỳ vọng updated');
      expect(again.item.completedBy).toBe(userId);
      expect(again.item.completedAt).toEqual(first.item.completedAt);
    });

    it('sửa due_date tay → due_text (chữ của model) bị xoá; đặt null cũng xoá; giao / bỏ giao người', async () => {
      const row = await oneItem({ dueText: 'thứ sáu', dueDate: '2026-10-30' });
      const member = await insertUser(t.db);
      await addMember(t.db, orgId, member.id);
      const out = await repo.updateIfVersion(
        row.id,
        1,
        { dueDate: '2026-11-05', assigneeId: member.id },
        userId,
      );
      if (out.kind !== 'updated') throw new Error('kỳ vọng updated');
      expect(out.item).toMatchObject({
        dueDate: '2026-11-05',
        dueText: null,
        assigneeId: member.id,
      });
      const cleared = await repo.updateIfVersion(
        row.id,
        2,
        { dueDate: null, assigneeId: null },
        userId,
      );
      if (cleared.kind !== 'updated') throw new Error('kỳ vọng updated');
      expect(cleared.item).toMatchObject({ dueDate: null, assigneeId: null });
    });

    it('patch rỗng vẫn tăng version (nhất quán với M13)', async () => {
      const row = await oneItem();
      const out = await repo.updateIfVersion(row.id, 1, {}, userId);
      expect(out.kind === 'updated' && out.item.version).toBe(2);
    });

    // Đột biến: bỏ `eq(version, expected)` khỏi WHERE → cả 10 đều thắng, "thắng sau" đè "thắng trước".
    it('CONCURRENCY: 10 PATCH song song cùng version → ĐÚNG MỘT thắng, chín lệch', async () => {
      const row = await oneItem();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.updateIfVersion(row.id, 1, { task: `người ${i}` }, userId),
        ),
      );
      const wins = results.filter((r) => r.kind === 'updated');
      expect(wins).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'version_mismatch')).toHaveLength(9);
      const [after] = await t.db.select().from(actionItems).where(eq(actionItems.id, row.id));
      expect(after!.version).toBe(2);
      expect(wins[0]).toMatchObject({ item: { task: after!.task } });
    });

    it('CHECK vẫn chặn từ repository: task rỗng → lỗi, dữ liệu nguyên', async () => {
      const row = await oneItem();
      const failure = await repo.updateIfVersion(row.id, 1, { task: '' }, userId).then(
        () => null,
        (error: unknown) => findPgError(error),
      );
      expect([failure?.code, failure?.constraint]).toEqual([
        '23514',
        'action_items_task_length_ck',
      ]);
      const [after] = await t.db.select().from(actionItems).where(eq(actionItems.id, row.id));
      expect(after).toMatchObject({ task: 'Việc 0', version: 1 });
    });
  });
});
