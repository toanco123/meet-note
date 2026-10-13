import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-code.js';

export interface ErrorDetail {
  /** Đường dẫn tới field lỗi, vd `members.0.role`. */
  field?: string;
  message: string;
}

/**
 * Lỗi nghiệp vụ. Service ném lỗi này; `AllExceptionsFilter` chuyển thành response chuẩn.
 * Kế thừa HttpException để Nest (và các filter khác) vẫn hiểu được status.
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

  static notFound(message = 'Không tìm thấy tài nguyên.'): AppException {
    return new AppException('NOT_FOUND', HttpStatus.NOT_FOUND, message);
  }

  static forbidden(message = 'Bạn không có quyền thực hiện hành động này.'): AppException {
    return new AppException('FORBIDDEN', HttpStatus.FORBIDDEN, message);
  }

  static conflict(code: ErrorCode, message: string): AppException {
    return new AppException(code, HttpStatus.CONFLICT, message);
  }
}
