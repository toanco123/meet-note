/** Kiểu dùng chung cho phân trang cursor. */

/** Giá trị trong cursor: cột sort + tie-breaker. Timestamp giữ dạng string lấy từ DB (đủ micro giây). */
export type CursorKey = string | number;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
