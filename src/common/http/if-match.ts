import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AppException } from '../errors/app.exception.js';
import { Errors } from '../errors/errors.js';

/** `version` là `integer` trong DB: số lớn hơn thế không thể là version của bản ghi nào. */
const MAX_VERSION = 2_147_483_647;

/**
 * Đọc `If-Match` thành version của bản ghi (khoá lạc quan — M13 Q3, dùng lại ở M12). `ETag` là
 * `"<version>"` (RFC 9110: ETag là chuỗi trong dấu nháy), nên client thường gửi lại đúng `"3"`; cũng
 * nhận `3` trần cho tiện curl.
 * - Thiếu → 428 với lỗi do CALLER chọn (`onMissing`, mã lỗi theo từng tài nguyên: transcript, action
 *   item…): không cho ghi mù (ghi đè mà không biết đang đè bản nào là lỗi mất dữ liệu kinh điển).
 * - `W/"3"` (weak) → 400: `If-Match` đòi so sánh MẠNH, weak validator không hợp lệ ở đây.
 * - `*` hoặc danh sách (`"1", "2"`) → 400: sửa phải gắn với MỘT version cụ thể, "bất kỳ" là ghi mù.
 */
export function parseIfMatchVersion(
  header: string | undefined,
  onMissing: () => AppException,
): number {
  if (header === undefined) throw onMissing();
  const match = /^\s*(?:"(\d{1,10})"|(\d{1,10}))\s*$/.exec(header);
  const version = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION) {
    throw Errors.common.validationFailed([
      { field: 'If-Match', message: 'Phải là một version dạng "3" (giá trị ETag của bản ghi).' },
    ]);
  }
  return version;
}

/**
 * `@IfMatchVersion(Errors.x.ifMatchRequired)`: version lấy từ header `If-Match` (xem
 * `parseIfMatchVersion`); đối số là hàm tạo lỗi 428 của tài nguyên đang sửa.
 */
export const IfMatchVersion = createParamDecorator(
  (onMissing: () => AppException, ctx: ExecutionContext) =>
    parseIfMatchVersion(ctx.switchToHttp().getRequest<Request>().headers['if-match'], onMissing),
);
