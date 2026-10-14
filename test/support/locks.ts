import { sql } from 'drizzle-orm';
import type { Database } from '../../src/infra/database/database.types.js';

/**
 * Đợi tới khi có ít nhất `count` transaction trong database NÀY đang chờ khoá dòng.
 *
 * Dùng để ép thứ tự xen kẽ XÁC ĐỊNH trong test race: "B chắc chắn đã chạm khoá A đang giữ" rồi
 * mới cho A commit. Không dùng `sleep`: ngắn thì test chập chờn, dài thì chậm.
 * Mỗi file test có database riêng (clone từ template) → lọc theo `current_database()` là đủ cô lập.
 */
export async function waitForLockWaiters(db: Database, count = 1, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Sau ${timeoutMs}ms vẫn chưa có ${count} transaction chờ khoá`);
}
