import { eq, sql } from 'drizzle-orm';
import type { AppException } from '../../src/common/errors/app.exception.js';
import type { Database, Transaction } from '../../src/infra/database/database.types.js';
import { channels } from '../../src/infra/database/schema/index.js';

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

/**
 * Ép thứ tự xen kẽ cho test race:
 *
 *   T1 (holder):   BEGIN → `hold(tx)` (khoá + đổi dữ liệu) ──── giữ khoá ──── COMMIT
 *   T2 (contender):              `contend()` → chạm khoá của T1 … ĐỢI … ─────────── → chạy tiếp
 *
 * T1 chỉ commit khi T2 đã THỰC SỰ đợi khoá (`waitForLockWaiters`) → T2 luôn thấy dữ liệu T1 vừa
 * commit. Kết quả của T2 trả về dạng chuỗi qua `outcomeOf` để so sánh gọn.
 */
export async function runWhileLocked(
  db: Database,
  hold: (tx: Transaction) => Promise<unknown>,
  contend: () => Promise<unknown>,
): Promise<string> {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = db.transaction(async (tx) => {
    await hold(tx);
    held.resolve();
    await release.promise;
  });

  await Promise.race([held.promise, holder]);
  const outcome = outcomeOf(contend());
  await waitForLockWaiters(db, 1);
  release.resolve();
  await holder;
  return outcome;
}

/** 'OK' hoặc mã lỗi (`AppException.code`); lỗi khác (vd lỗi Postgres lọt ra) → chuỗi mô tả. */
export async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as Partial<AppException>).code ?? String(error);
  }
}

/** `hold` cho `runWhileLocked`: khoá dòng kênh như MỌI thao tác ghi trên kênh, rồi làm `change`. */
export function lockChannelThen(
  channelId: string,
  change: (tx: Transaction) => Promise<unknown>,
): (tx: Transaction) => Promise<void> {
  return async (tx) => {
    await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    await change(tx);
  };
}
