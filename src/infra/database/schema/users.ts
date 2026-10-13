import { type SQL, sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Lưu nguyên dạng người dùng nhập; so trùng không phân biệt hoa thường qua index `lower(email)`. */
    email: text().notNull(),
    /** Chuỗi PHC của argon2id (`$argon2id$v=19$m=…`), chứa cả salt và tham số. */
    passwordHash: text().notNull(),
    displayName: text().notNull(),
    /**
     * Dùng để tìm thành viên không dấu (M2/M4). Generated nên không bao giờ lệch với dữ liệu gốc.
     * Phải dùng `f_unaccent` (IMMUTABLE) — `unaccent()` (STABLE) không được phép trong generated column.
     */
    searchText: text()
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`f_unaccent(lower(${users.displayName} || ' ' || ${users.email}))`,
      ),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Tên này được service dùng để nhận ra lỗi "email đã tồn tại" → 409 AUTH_EMAIL_TAKEN.
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    index('users_search_text_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
    // DTO đã validate; CHECK là lớp chặn cuối nếu dữ liệu đi vào bằng đường khác.
    check('users_email_length_ck', sql`char_length(${t.email}) between 3 and 254`),
    check('users_display_name_length_ck', sql`char_length(${t.displayName}) between 1 and 80`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
