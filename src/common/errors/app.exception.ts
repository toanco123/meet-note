import { HttpException, type HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-code.js';

export interface ErrorDetail {
  /** Đường dẫn tới field lỗi, vd `members.0.role`. */
  field?: string;
  message: string;
}

/**
 * Lỗi nghiệp vụ; `AllExceptionsFilter` chuyển thành response chuẩn. Kế thừa HttpException để Nest
 * (và các filter khác) vẫn hiểu được status.
 *
 * KHÔNG tự `new AppException(...)` trong module: lấy từ catalog `Errors` (`./errors.ts`) để mọi
 * thông điệp nằm một chỗ. Test kiến trúc chặn việc tạo lỗi ngoài catalog.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    status: HttpStatus,
    message?: string,
    readonly details?: ErrorDetail[],
  ) {
    super({ code, message: message ?? code, details }, status);
  }
}
