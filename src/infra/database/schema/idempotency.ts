import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { users } from './users.js';

export const IDEMPOTENCY_STATUSES = ['processing', 'completed'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

/**
 * Header `Idempotency-Key` cho các POST không tự idempotent (M5 Q3). Theo từng user.
 *
 * - `processing`: request đầu đang chạy → request cùng key nhận 409.
 * - `completed`: lưu response → gọi lại cùng key + cùng nội dung → trả lại đúng response đó.
 * - `request_hash` khác lần đầu → 422 (dùng lại key cho request khác).
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid().notNull(),
    key: text().notNull(),
    method: text().notNull(),
    path: text().notNull(),
    /** sha256 (hex) của method + path + body. */
    requestHash: text().notNull(),
    status: text({ enum: IDEMPOTENCY_STATUSES }).notNull().default('processing'),
    responseStatus: integer(),
    responseBody: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pk', columns: [t.userId, t.key] }),
    foreignKey({
      name: 'idempotency_keys_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
    check('idempotency_keys_status_ck', inValues(t.status, IDEMPOTENCY_STATUSES)),
    check('idempotency_keys_key_length_ck', sql`char_length(${t.key}) between 1 and 255`),
    // `completed` ⇔ đã lưu response.
    check(
      'idempotency_keys_completed_ck',
      sql`(${t.status} = 'completed') = (${t.responseStatus} is not null)`,
    ),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
