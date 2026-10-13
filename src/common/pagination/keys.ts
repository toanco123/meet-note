import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { isUuid } from '../validation/uuid.js';
import { type CursorKey, invalidCursor } from './cursor.js';

/**
 * Khoá thời gian cho cursor, do Postgres sinh: ISO 8601 UTC đủ MICRO giây.
 * Không đi qua JS `Date` (chỉ có mili giây) → trang sau không lặp/mất dòng có cùng mili giây.
 * Định dạng cố định → kiểm tra được bằng regex trước khi đưa ngược vào SQL.
 */
export function timestampKey(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const TIMESTAMP_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Cursor nằm trong tay client — có thể bị sửa. Giá trị rác mà đưa thẳng vào `::timestamptz` /
 * `::uuid` thì Postgres ném lỗi ép kiểu → 500. Kiểm tra ở đây để trả 400 INVALID_CURSOR.
 */
export function expectTimestampKey(value: CursorKey | undefined): string {
  if (typeof value !== 'string' || !TIMESTAMP_KEY.test(value)) throw invalidCursor();
  return value;
}

/** Khoá số nguyên dương (vd id `bigint identity`) — chặn số thực, số âm, số vượt `Number.MAX_SAFE_INTEGER`. */
export function expectPositiveIntKey(value: CursorKey | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw invalidCursor();
  return value;
}

export function expectUuidKey(value: CursorKey | undefined): string {
  if (!isUuid(value)) throw invalidCursor();
  return value;
}

/**
 * Escape ký tự đặc biệt của LIKE (`%`, `_`, `\`) để chuỗi người dùng nhập được tìm NGUYÊN VĂN.
 * Thiếu bước này: tìm "%" khớp mọi dòng, tìm "a_b" khớp "axb". Dùng kèm `ESCAPE '\'` trong SQL.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
