import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  auditLogs,
  organizationInvites,
  organizationJoinRequests,
} from '../../../../../src/infra/database/schema/index.js';
import { insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

describe('Schema invites / join requests / audit (Postgres thật)', () => {
  let t: TestDb;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb();
    const owner = await insertUser(t.db);
    userId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, owner.id)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  const invite = (overrides: Partial<typeof organizationInvites.$inferInsert> = {}) =>
    t.db
      .insert(organizationInvites)
      .values({
        orgId,
        tokenHash: randomBytes(32),
        expiresAt: new Date(Date.now() + 3_600_000),
        ...overrides,
      })
      .returning();

  describe('organization_invites', () => {
    it('max_uses = 0 bị CHECK chặn', async () => {
      expect(await pgErrorOf(invite({ maxUses: 0 }))).toMatchObject({
        code: '23514',
        constraint: 'organization_invites_max_uses_ck',
      });
    });

    it('use_count vượt max_uses bị CHECK chặn (lưới an toàn cuối dù code có bug)', async () => {
      const [row] = await invite({ maxUses: 2, useCount: 2 });
      const error = await pgErrorOf(
        t.db
          .update(organizationInvites)
          .set({ useCount: sql`${organizationInvites.useCount} + 1` })
          .where(eq(organizationInvites.id, row?.id ?? '')),
      );
      expect(error).toMatchObject({
        code: '23514',
        constraint: 'organization_invites_use_count_ck',
      });
    });

    it('max_uses NULL = không giới hạn', async () => {
      await expect(invite({ maxUses: null, useCount: 10_000 })).resolves.toHaveLength(1);
    });
  });

  describe('organization_join_requests', () => {
    const request = (status: 'pending' | 'approved' = 'pending') =>
      t.db.insert(organizationJoinRequests).values({
        orgId,
        userId,
        role: 'member',
        status,
        ...(status === 'pending' ? {} : { decidedAt: new Date() }),
      });

    it('2 yêu cầu pending cùng (org, user) → 23505; yêu cầu đã xử lý thì không tính', async () => {
      await request('approved');
      await request('pending');
      expect(await pgErrorOf(request('pending'))).toMatchObject({
        code: '23505',
        constraint: 'organization_join_requests_one_pending_uq',
      });
    });

    it('đã duyệt mà thiếu decided_at bị CHECK chặn', async () => {
      const error = await pgErrorOf(
        t.db.insert(organizationJoinRequests).values({
          orgId,
          userId: (await insertUser(t.db)).id,
          role: 'member',
          status: 'approved',
        }),
      );
      expect(error).toMatchObject({
        code: '23514',
        constraint: 'organization_join_requests_decided_ck',
      });
    });
  });

  describe('audit_logs — chỉ ghi thêm', () => {
    async function insertLog() {
      const [row] = await t.db
        .insert(auditLogs)
        .values({ orgId, action: 'test.action', targetType: 'test', targetId: 'x' })
        .returning();
      if (!row) throw new Error('insert audit thất bại');
      return row;
    }

    it('không có FK: ghi được log cho org/actor không tồn tại (log sống lâu hơn bản ghi)', async () => {
      await expect(
        t.db.insert(auditLogs).values({
          orgId: randomUUID(),
          actorId: randomUUID(),
          action: 'test.orphan',
          targetType: 'test',
          targetId: 'y',
        }),
      ).resolves.toBeDefined();
    });

    const mutations = [
      [
        'UPDATE',
        (db: TestDb['db'], id: number) =>
          db.update(auditLogs).set({ action: 'sửa lén' }).where(eq(auditLogs.id, id)),
      ],
      [
        'DELETE',
        (db: TestDb['db'], id: number) => db.delete(auditLogs).where(eq(auditLogs.id, id)),
      ],
      ['TRUNCATE', (db: TestDb['db']) => db.execute(sql`truncate audit_logs`)],
    ] as const;

    // Hai lớp (M11 B6): user của app không có quyền sửa / xoá / truncate (42501) — chặn TRƯỚC khi
    // tới trigger; trigger (23001) vẫn chặn cả chủ schema.
    it.each(mutations)('%s bằng user của app → thiếu quyền (42501)', async (_op, mutate) => {
      const log = await insertLog();
      expect((await pgErrorOf(mutate(t.db, log.id)))?.code).toBe('42501');
      const [still] = await t.db.select().from(auditLogs).where(eq(auditLogs.id, log.id));
      expect(still?.action).toBe('test.action');
    });

    it.each(mutations)('%s bằng chủ schema → trigger từ chối (23001)', async (_op, mutate) => {
      const owner = createTestDb(1, process.env.TEST_ADMIN_DATABASE_URL);
      try {
        const log = await insertLog();
        expect((await pgErrorOf(mutate(owner.db, log.id)))?.code).toBe('23001');
        const [still] = await t.db.select().from(auditLogs).where(eq(auditLogs.id, log.id));
        expect(still?.action).toBe('test.action');
      } finally {
        await owner.close();
      }
    });
  });

  /**
   * Postgres mặc định `ORDER BY x DESC` = `DESC NULLS FIRST`. Index tạo `DESC NULLS LAST` (mặc định
   * của `.desc()` trong Drizzle) thì KHÔNG khớp → phải thêm bước Sort.
   */
  describe('index DESC phải khớp thứ tự NULL của ORDER BY', () => {
    async function planOf(orderBy: string): Promise<string> {
      return t.db.transaction(async (tx) => {
        // Bitmap scan không giữ thứ tự → luôn phải Sort; tắt cả hai để lộ đúng câu hỏi
        // "index có phục vụ được ORDER BY không". ANALYZE để planner có thống kê như ở production.
        await tx.execute(sql`analyze audit_logs`);
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_bitmapscan = off`);
        const result = await tx.execute(
          sql.raw(
            `explain select id from audit_logs where org_id = '${orgId}' order by ${orderBy} limit 21`,
          ),
        );
        return result.rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });
    }

    it('ORDER BY created_at DESC, id DESC → đọc thẳng index, không Sort', async () => {
      const plan = await planOf('created_at desc, id desc');
      expect(plan).toContain('audit_logs_org_created_idx');
      expect(plan).not.toMatch(/\bSort\b/);
    });

    it('ORDER BY … DESC NULLS LAST (lệch index) → phải Sort', async () => {
      const plan = await planOf('created_at desc nulls last, id desc nulls last');
      expect(plan).toMatch(/\bSort\b/);
    });
  });
});
