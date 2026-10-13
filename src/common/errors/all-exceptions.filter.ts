import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AppException, type ErrorDetail } from './app.exception.js';
import { defaultCodeForStatus, ErrorCode } from './error-code.js';
import type { ErrorResponseDto } from './error-response.dto.js';

export interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: ErrorDetail[];
}

/** SQLSTATE của Postgres: https://www.postgresql.org/docs/current/errcodes-appendix.html */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

interface PgLikeError {
  code: string;
  constraint?: string;
}

/**
 * Drizzle (≥ 0.44) bọc lỗi driver trong DrizzleQueryError, lỗi gốc của `pg` nằm ở `.cause`.
 * Vì vậy phải đi dọc chuỗi `cause` thay vì kiểm tra trực tiếp.
 */
export function findPgError(error: unknown, depth = 0): PgLikeError | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; severity?: unknown; cause?: unknown };
  if (
    typeof candidate.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(candidate.code) &&
    candidate.severity !== undefined
  ) {
    return candidate as PgLikeError;
  }
  return findPgError(candidate.cause, depth + 1);
}

/** Lỗi 4xx từ middleware Express (body-parser: JSON hỏng, body quá lớn) có `status` + `expose`. */
function asExposedClientError(error: unknown): { status: number; message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; expose?: unknown; message?: unknown };
  if (typeof e.status === 'number' && e.status >= 400 && e.status < 500 && e.expose === true) {
    return { status: e.status, message: typeof e.message === 'string' ? e.message : 'Bad request' };
  }
  return undefined;
}

/** Hàm thuần — tách khỏi filter để unit test không cần HTTP. */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppException) {
    const body = exception.getResponse() as { message: string };
    return {
      status: exception.getStatus(),
      code: exception.code,
      message: body.message,
      details: exception.details,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse();
    const resMessage = typeof res === 'object' ? (res as { message?: unknown }).message : res;
    return {
      status,
      code: defaultCodeForStatus(status),
      message: typeof resMessage === 'string' ? resMessage : exception.message,
    };
  }

  const pgError = findPgError(exception);
  if (pgError?.code === PG_UNIQUE_VIOLATION) {
    return {
      status: HttpStatus.CONFLICT,
      code: ErrorCode.Conflict,
      message: 'Dữ liệu đã tồn tại.',
    };
  }
  if (pgError?.code === PG_FOREIGN_KEY_VIOLATION) {
    return {
      status: HttpStatus.CONFLICT,
      code: ErrorCode.Conflict,
      message: 'Dữ liệu tham chiếu không hợp lệ hoặc đang được sử dụng.',
    };
  }

  const clientError = asExposedClientError(exception);
  if (clientError) {
    return {
      status: clientError.status,
      code: defaultCodeForStatus(clientError.status),
      message: clientError.message,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.InternalError,
    message: 'Đã có lỗi xảy ra. Vui lòng thử lại sau.',
  };
}

/**
 * Bắt MỌI exception của HTTP request và trả về `{ error: { code, message, details, requestId } }`.
 * Lỗi 5xx được log đầy đủ ở server, client chỉ nhận thông điệp chung (không lộ stack/SQL).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Chỉ xử lý HTTP. WebSocket (M7) sẽ có filter riêng.
    if (host.getType() !== 'http') throw exception;

    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    // pino-http gắn `req.id` (do resolveRequestId sinh, luôn là string).
    const request = ctx.getRequest<{ id?: unknown }>();
    const requestId = typeof request.id === 'string' ? request.id : undefined;
    const mapped = mapException(exception);

    if (mapped.status >= 500) {
      this.logger.error(exception);
    }

    const body: ErrorResponseDto = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details?.length ? { details: mapped.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    httpAdapter.reply(ctx.getResponse(), body, mapped.status);
  }
}
