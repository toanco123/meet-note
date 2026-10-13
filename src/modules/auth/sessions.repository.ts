import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  refreshTokens,
  type RefreshTokenRow,
  type SessionRevokedReason,
  type SessionRow,
  sessions,
} from '../../infra/database/schema/index.js';

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Truy vấn thuần cho sessions + refresh_tokens. Mọi hàm nhận `executor` để chạy được trong
 * transaction của service; ranh giới transaction thuộc về service, không thuộc repository.
 */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insertSession(userId: string, meta: SessionMeta, executor: DbExecutor = this.db) {
    const [row] = await executor
      .insert(sessions)
      .values({ userId, userAgent: meta.userAgent ?? null, ip: meta.ip ?? null })
      .returning();
    return required(row);
  }

  async insertRefreshToken(
    values: { sessionId: string; tokenHash: Buffer; expiresAt: Date },
    executor: DbExecutor = this.db,
  ) {
    const [row] = await executor.insert(refreshTokens).values(values).returning();
    return required(row);
  }

  /**
   * `FOR UPDATE`: request refresh thứ hai với CÙNG token phải đợi request đầu commit, rồi mới
   * đọc — lúc đó nó thấy `rotated_at` đã có. Bỏ khoá thì cả hai cùng thấy "chưa xoay" và cùng
   * cấp token mới (xem test concurrency trong sessions.service.int-spec.ts).
   */
  async findRefreshTokenForUpdate(
    tokenHash: Buffer,
    executor: DbExecutor,
  ): Promise<RefreshTokenRow | undefined> {
    const [row] = await executor
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for('update');
    return row;
  }

  async findSessionForUpdate(id: string, executor: DbExecutor): Promise<SessionRow | undefined> {
    const [row] = await executor.select().from(sessions).where(eq(sessions.id, id)).for('update');
    return row;
  }

  async markRotated(id: string, replacedById: string, at: Date, executor: DbExecutor) {
    await executor
      .update(refreshTokens)
      .set({ rotatedAt: at, replacedById })
      .where(eq(refreshTokens.id, id));
  }

  async touchSession(id: string, at: Date, executor: DbExecutor) {
    await executor.update(sessions).set({ lastUsedAt: at }).where(eq(sessions.id, id));
  }

  /**
   * UPDATE có điều kiện — không cần khoá trước: `revoked_at IS NULL` trong WHERE khiến thu hồi
   * hai lần là vô hại, `user_id` trong WHERE khiến không thu hồi được phiên của người khác.
   * @returns true nếu thực sự thu hồi một phiên đang sống.
   */
  async revokeSession(
    params: { sessionId: string; userId?: string; reason: SessionRevokedReason; at: Date },
    executor: DbExecutor = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .update(sessions)
      .set({ revokedAt: params.at, revokedReason: params.reason })
      .where(
        and(
          eq(sessions.id, params.sessionId),
          params.userId ? eq(sessions.userId, params.userId) : undefined,
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  async revokeAllSessions(
    userId: string,
    reason: SessionRevokedReason,
    at: Date,
    executor: DbExecutor = this.db,
  ): Promise<number> {
    const rows = await executor
      .update(sessions)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  /** Guard gọi ở mỗi request: tra theo khoá chính, dùng `sessions_pkey`. */
  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)),
      );
    return row !== undefined;
  }

  listActive(userId: string): Promise<SessionRow[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastUsedAt));
  }
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('INSERT … RETURNING không trả về dòng nào');
  return row;
}
