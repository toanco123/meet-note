import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { type IdempotencyKeyRow, idempotencyKeys } from '../../infra/database/schema/index.js';
import { IDEMPOTENCY_LEASE_SECONDS, IDEMPOTENCY_TTL_SECONDS } from './idempotency-key.js';
import type { IdempotentRequest } from './idempotency.types.js';

const t = idempotencyKeys;

/** Điều kiện "chỉ chủ hiện tại của chỗ giữ": `created_at` là fencing token (xem `claim`). */
const ownedBy = (r: Pick<IdempotentRequest, 'userId' | 'key'>, claimedAt: string) =>
  and(
    eq(t.userId, r.userId),
    eq(t.key, r.key),
    eq(t.status, 'processing'),
    sql`${t.createdAt} = ${claimedAt}::timestamptz`,
  );

@Injectable()
export class IdempotencyRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Giữ chỗ key bằng MỘT câu lệnh — kiểm tra và ghi là nguyên tử. Kiểu "SELECT xem có chưa rồi mới
   * INSERT" để hở một khe: hai request cùng thấy "chưa có" rồi cùng chạy handler.
   *
   * Hai request cùng key tới cùng lúc: PK `(user_id, key)` bắt INSERT thứ hai CHỜ INSERT đầu commit,
   * rồi đi vào nhánh `ON CONFLICT`. Nhánh đó chỉ chiếm lại dòng cũ khi:
   * - dòng đã hết hạn (`expires_at` qua) — như key mới;
   * - hoặc `processing` quá lease VÀ cùng nội dung — request đầu đã chết giữa chừng.
   * Còn lại `WHERE` sai → không dòng nào → trả `undefined` (người khác đang giữ / đã xong).
   *
   * Trả `created_at` dạng TEXT (đủ micro giây, đi qua JS `Date` sẽ mất) làm **fencing token**: mỗi lần
   * giữ chỗ đặt `created_at = now()` mới, nên request cũ "sống dậy" sau khi bị chiếm chỗ không còn
   * khớp token → không ghi đè / xoá được chỗ của người mới.
   */
  async claim(r: IdempotentRequest): Promise<string | undefined> {
    const [row] = await this.db
      .insert(t)
      .values({
        userId: r.userId,
        key: r.key,
        method: r.method,
        path: r.path,
        requestHash: r.requestHash,
        expiresAt: sql`now() + make_interval(secs => ${IDEMPOTENCY_TTL_SECONDS})`,
      })
      .onConflictDoUpdate({
        target: [t.userId, t.key],
        set: {
          method: sql`excluded.method`,
          path: sql`excluded.path`,
          requestHash: sql`excluded.request_hash`,
          status: 'processing',
          responseStatus: sql`null`,
          responseBody: sql`null`,
          createdAt: sql`now()`,
          expiresAt: sql`excluded.expires_at`,
        },
        setWhere: sql`${t.expiresAt} <= now()
          or (${t.status} = 'processing'
              and ${t.requestHash} = excluded.request_hash
              and ${t.createdAt} < now() - make_interval(secs => ${IDEMPOTENCY_LEASE_SECONDS}))`,
      })
      .returning({ claimedAt: sql<string>`${t.createdAt}::text` });
    return row?.claimedAt;
  }

  async find(userId: string, key: string): Promise<IdempotencyKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), eq(t.key, key)));
    return row;
  }

  /** Lưu response. `false` = đã mất chỗ giữ (quá lease, người khác chiếm) → không ghi đè. */
  async complete(
    r: Pick<IdempotentRequest, 'userId' | 'key'>,
    claimedAt: string,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<boolean> {
    const rows = await this.db
      .update(t)
      .set({ status: 'completed', responseStatus, responseBody: responseBody ?? null })
      .where(ownedBy(r, claimedAt))
      .returning({ key: t.key });
    return rows.length > 0;
  }

  /**
   * Xoá một lô key hết hạn; trả số dòng đã xoá (gọi lặp tới khi 0). Lên lịch cùng job dọn upload ở
   * M6. `SKIP LOCKED`: dòng đang bị `claim` chiếm lại (đang khoá) thì bỏ qua; ngược lại `claim` gặp
   * dòng đang bị xoá thì CHỜ, rồi INSERT như key mới (Postgres thử lại nhánh conflict khi dòng
   * xung đột biến mất) — không có lỗi trùng khoá lọt ra.
   */
  async deleteExpiredBatch(limit = 1000): Promise<number> {
    const batch = this.db
      .select({ userId: t.userId, key: t.key })
      .from(t)
      .where(sql`${t.expiresAt} <= now()`)
      .orderBy(asc(t.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    const rows = await this.db
      .delete(t)
      .where(sql`(${t.userId}, ${t.key}) in (${batch})`)
      .returning({ key: t.key });
    return rows.length;
  }

  /** Handler lỗi → bỏ chỗ giữ để client gửi lại cùng key (lỗi KHÔNG được ghi nhớ). */
  async release(r: Pick<IdempotentRequest, 'userId' | 'key'>, claimedAt: string): Promise<void> {
    await this.db.delete(t).where(ownedBy(r, claimedAt));
  }
}
