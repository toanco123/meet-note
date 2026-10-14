import { eq, sql } from 'drizzle-orm';
import { AppException } from '../../src/common/errors/app.exception.js';
import { findPgError } from '../../src/common/errors/pg-error.js';
import type { Database, Transaction } from '../../src/infra/database/database.types.js';
import { channels } from '../../src/infra/database/schema/index.js';

/**
 * Đợi tới khi có ít nhất `count` transaction trong database NÀY đang chờ khoá dòng.
 *
 * Dùng để ép thứ tự xen kẽ XÁC ĐỊNH trong test race: "B chắc chắn đã chạm khoá A đang giữ" rồi
 * mới cho A commit. Không dùng `sleep`: ngắn thì test chập chờn, dài thì chậm.
 * Mỗi file test có database riêng (clone từ template) → lọc theo `current_database()` là đủ cô lập.
 */
export async function waitForLockWaiters(
  db: Database,
  count = 1,
  timeoutMs = 5000,
  /** Dừng chờ (không lỗi) khi promise này xong — vd T2 chạy hết mà không cần đợi khoá. */
  stopWhen?: Promise<unknown>,
): Promise<void> {
  let stopped = false;
  void stopWhen?.then(
    () => (stopped = true),
    () => (stopped = true),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped) return;
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
 *   T1 (holder):    BEGIN → `hold(tx)` (khoá…) ── giữ khoá ── [`afterWait(tx)`] ── COMMIT
 *   T2 (contender):           `contend()` → chạm khoá của T1 … ĐỢI … ──────────── → chạy tiếp
 *
 * T1 chỉ đi tiếp khi T2 đã THỰC SỰ đợi khoá (`waitForLockWaiters`). `afterWait` (tuỳ chọn) chạy ở
 * thời điểm đó, vd xoá một dòng mà cascade cần khoá T2 có thể đang giữ — chính là chỗ deadlock
 * xảy ra nếu T2 khoá sai thứ tự. Trả kết quả CẢ HAI phía (`outcomeOf`) để thấy ai bị Postgres
 * chọn làm nạn nhân (`pg:40P01`).
 */
export async function interleave(
  db: Database,
  steps: {
    hold: (tx: Transaction) => Promise<unknown>;
    contend: () => Promise<unknown>;
    afterWait?: (tx: Transaction) => Promise<unknown>;
  },
): Promise<{ holder: string; contender: string }> {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = outcomeOf(
    db.transaction(async (tx) => {
      await steps.hold(tx);
      held.resolve();
      await release.promise;
      await steps.afterWait?.(tx);
    }),
  );

  await Promise.race([held.promise, holder]);
  const contender = outcomeOf(steps.contend());
  // Code đúng: T2 phải đợi khoá. Code đột biến: T2 có thể chạy thẳng tới xong — vẫn đi tiếp để
  // assert thấy HẬU QUẢ thật (vd kênh mất chủ), thay vì đỏ vì timeout của bước chờ.
  await waitForLockWaiters(db, 1, 5000, contender);
  release.resolve();
  return { holder: await holder, contender: await contender };
}

/** `interleave` khi T1 chỉ giữ khoá rồi commit: trả kết quả của T2; T1 lỗi thì ném luôn. */
export async function runWhileLocked(
  db: Database,
  hold: (tx: Transaction) => Promise<unknown>,
  contend: () => Promise<unknown>,
): Promise<string> {
  const { holder, contender } = await interleave(db, { hold, contend });
  if (holder !== 'OK') throw new Error(`Transaction giữ khoá thất bại: ${holder}`);
  return contender;
}

/**
 * 'OK', mã lỗi nghiệp vụ (`AppException.code`), hoặc `pg:<SQLSTATE>` cho lỗi Postgres lọt ra
 * (vd `pg:40P01` deadlock, `pg:23503` vi phạm FK). Còn lại → chuỗi mô tả.
 */
export async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (error instanceof AppException) return error.code;
    const pg = findPgError(error);
    return pg ? `pg:${pg.code}` : String(error);
  }
}

/** `hold` cho `runWhileLocked` / `interleave`: khoá dòng kênh như MỌI thao tác ghi trên kênh, rồi làm `change`. */
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
