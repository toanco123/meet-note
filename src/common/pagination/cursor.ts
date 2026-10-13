import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-code.js';

const CURSOR_VERSION = 1;

/** Giá trị trong cursor: cột sort + tie-breaker. Timestamp giữ dạng string lấy từ DB (đủ micro giây). */
export type CursorKey = string | number;

interface CursorPayload {
  v: number;
  k: CursorKey[];
}

/** Cursor là opaque với client: base64url(JSON). Không chứa dữ liệu nhạy cảm. */
export function encodeCursor(keys: CursorKey[]): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, k: keys };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * @param expectedLength số phần tử khoá của danh sách đang gọi — cursor từ danh sách khác
 * (khác số cột sort) bị từ chối thay vì cho ra kết quả sai.
 */
export function decodeCursor(cursor: string, expectedLength: number): CursorKey[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (!isCursorPayload(payload) || payload.k.length !== expectedLength) {
    throw invalidCursor();
  }
  return payload.k;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { v, k } = value as Partial<CursorPayload>;
  return (
    v === CURSOR_VERSION &&
    Array.isArray(k) &&
    k.every((key) => typeof key === 'string' || typeof key === 'number')
  );
}

function invalidCursor(): AppException {
  return new AppException(ErrorCode.InvalidCursor, HttpStatus.BAD_REQUEST, 'Cursor không hợp lệ.');
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Repository lấy `limit + 1` dòng. Nếu có dòng thừa → còn trang sau, cursor lấy từ dòng cuối
 * của trang hiện tại (KHÔNG phải dòng thừa).
 */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => CursorKey[]): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return {
    data,
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}
