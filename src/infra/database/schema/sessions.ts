import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, inValues } from './column-types.js';
import { users } from './users.js';

export const SESSION_REVOKED_REASONS = [
  'logout',
  'logout_all',
  'revoked_by_user',
  'reuse_detected',
] as const;
export type SessionRevokedReason = (typeof SESSION_REVOKED_REASONS)[number];

/**
 * Một dòng = một lần đăng nhập trên một thiết bị. `id` là `sid` trong access JWT và KHÔNG đổi
 * khi refresh — nhờ vậy guard kiểm tra "phiên còn sống" bằng một lần tra theo khoá chính.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid().notNull(),
    userAgent: text(),
    /** Kiểu `inet`: Postgres tự kiểm tra định dạng IPv4/IPv6. */
    ip: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedReason: text({ enum: SESSION_REVOKED_REASONS }),
  },
  (t) => [
    foreignKey({
      name: 'sessions_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    // `/me/sessions` và logout-all chỉ quan tâm phiên còn sống → partial index nhỏ gọn.
    index('sessions_user_active_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    check('sessions_revoked_reason_ck', inValues(t.revokedReason, SESSION_REVOKED_REASONS)),
    // Bất biến: thu hồi thì phải có lý do, chưa thu hồi thì không được có lý do.
    check(
      'sessions_revoked_consistency_ck',
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null)`,
    ),
  ],
);

/**
 * Mỗi lần refresh thêm một dòng mới; dòng cũ được đánh dấu `rotated_at` + `replaced_by_id`.
 * Chỉ lưu SHA-256 của token — lộ DB không lộ token dùng được.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    sessionId: uuid().notNull(),
    tokenHash: bytea().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp({ withTimezone: true }),
    replacedById: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'refresh_tokens_session_fk',
      columns: [t.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'refresh_tokens_replaced_by_fk',
      columns: [t.replacedById],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_session_idx').on(t.sessionId),
    check('refresh_tokens_hash_length_ck', sql`octet_length(${t.tokenHash}) = 32`),
    check(
      'refresh_tokens_rotation_consistency_ck',
      sql`(${t.rotatedAt} is null) = (${t.replacedById} is null)`,
    ),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
