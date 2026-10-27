import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../../common/errors/errors.js';

/** `version` là `integer` trong DB: số lớn hơn thế không thể là version của đoạn nào. */
const MAX_VERSION = 2_147_483_647;

/**
 * Đọc `If-Match` thành version của đoạn (M13 Q3). `ETag` của đoạn là `"<version>"` (RFC 9110: ETag là
 * chuỗi trong dấu nháy), nên client thường gửi lại đúng `"3"`; cũng nhận `3` trần cho tiện curl.
 * - Thiếu → 428: không cho ghi mù (ghi đè mà không biết đang đè bản nào là lỗi mất dữ liệu kinh điển).
 * - `W/"3"` (weak) → 400: `If-Match` đòi so sánh MẠNH, weak validator không hợp lệ ở đây.
 * - `*` hoặc danh sách (`"1", "2"`) → 400: sửa phải gắn với MỘT version cụ thể, "bất kỳ" là ghi mù.
 */
export function parseIfMatchVersion(header: string | undefined): number {
  if (header === undefined) throw Errors.transcript.ifMatchRequired();
  const match = /^\s*(?:"(\d{1,10})"|(\d{1,10}))\s*$/.exec(header);
  const version = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) {
    throw Errors.common.validationFailed([
      { field: 'If-Match', message: 'Phải là một version dạng "3" (giá trị ETag của đoạn).' },
    ]);
  }
  return version;
}

/** `@IfMatchVersion()`: version lấy từ header `If-Match` (xem `parseIfMatchVersion`). */
export const IfMatchVersion = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  parseIfMatchVersion(ctx.switchToHttp().getRequest<Request>().headers['if-match']),
);
