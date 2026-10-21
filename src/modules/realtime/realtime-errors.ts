import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import type { RealtimeErrorData } from './realtime.types.js';

/**
 * Đổi lỗi thành `Error` mà Socket.IO gửi cho client qua `connect_error`: client đọc `err.data.code`
 * — cùng mã với REST. Lỗi không phải AppException (bug, DB sập) → mã chung, không lộ chi tiết.
 */
export function toConnectError(error: unknown): Error & { data: RealtimeErrorData } {
  const data: RealtimeErrorData =
    error instanceof AppException
      ? {
          code: error.code,
          statusCode: error.getStatus(),
          message: (error.getResponse() as { message: string }).message,
        }
      : {
          code: ErrorCode.InternalError,
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Đã có lỗi xảy ra. Vui lòng thử lại sau.',
        };
  return Object.assign(new Error(data.message), { data });
}
