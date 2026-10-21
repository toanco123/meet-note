import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import type { RealtimeErrorData } from './realtime.types.js';

/**
 * Cùng vỏ lỗi với REST (`{ code, statusCode, message }`) — dùng cho `connect_error` và ack.
 * Lỗi không phải AppException (bug, DB sập) → mã chung, không lộ chi tiết.
 */
export function toRealtimeError(error: unknown): RealtimeErrorData {
  if (error instanceof AppException) {
    return {
      code: error.code,
      statusCode: error.getStatus(),
      message: (error.getResponse() as { message: string }).message,
    };
  }
  return {
    code: ErrorCode.InternalError,
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Đã có lỗi xảy ra. Vui lòng thử lại sau.',
  };
}

/** `Error` mà Socket.IO gửi cho client qua `connect_error`: client đọc `err.data.code`. */
export function toConnectError(error: unknown): Error & { data: RealtimeErrorData } {
  const data = toRealtimeError(error);
  return Object.assign(new Error(data.message), { data });
}
