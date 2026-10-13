import { type AnyPgColumn, customType } from 'drizzle-orm/pg-core';
import { type SQL, sql } from 'drizzle-orm';

/** Drizzle 0.45 chưa có `bytea` dựng sẵn. `pg` trả bytea về dạng `Buffer`. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * `col IN ('a', 'b')` cho CHECK constraint của enum dạng text.
 * Giá trị là hằng trong code (không phải input người dùng) nên ghép thẳng vào SQL là an toàn.
 */
export function inValues(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
  return sql`${column} in (${sql.raw(list)})`;
}
