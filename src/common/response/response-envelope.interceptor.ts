import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { Page } from '../pagination/pagination.types.js';
import { PAGINATED_KEY, RAW_RESPONSE_KEY } from './response-envelope.js';
import type { PaginatedMetaDto, ResponseMetaDto } from './response-meta.dto.js';

/**
 * Bọc MỌI response thành công thành `{ data, meta: { statusCode, requestId } }` — một chỗ, ở ranh giới HTTP.
 *
 * - Service / controller không biết gì về envelope: vẫn trả DTO hoặc `Page<T>`.
 * - Danh sách nhận biết bằng metadata của `@ApiPaginatedResponse`, KHÔNG đoán theo shape (một DTO
 *   tình cờ có field `data` sẽ bị hiểu nhầm).
 * - Không bọc: `undefined` (204), route `@RawResponse()`, lỗi (lỗi đi qua `AllExceptionsFilter`
 *   với dạng `{ error }` riêng, không chạy qua `map` ở đây).
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, targets)) return next.handle();

    const paginated = this.reflector.get<boolean>(PAGINATED_KEY, context.getHandler()) === true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    return next.handle().pipe(
      map((result: unknown) => {
        if (result === undefined) return result;
        const requestId = requestIdOf(request);
        // Nest đặt status (`@HttpCode` / mặc định 200, POST 201) TRƯỚC khi interceptor chạy, và handler
        // dùng `res.status()` thì cũng đã chạy xong → đây là status thật sẽ gửi đi.
        const { statusCode } = response;
        if (!paginated) {
          const meta: ResponseMetaDto = { statusCode, requestId };
          return { data: result, meta };
        }
        if (!isPage(result)) {
          throw new Error(
            `${context.getClass().name}.${context.getHandler().name} có @ApiPaginatedResponse nhưng không trả Page<T>`,
          );
        }
        const meta: PaginatedMetaDto = { statusCode, requestId, nextCursor: result.nextCursor };
        return { data: result.data, meta };
      }),
    );
  }
}

function isPage(value: unknown): value is Page<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Page<unknown>).data) &&
    'nextCursor' in value
  );
}

/**
 * pino-http gắn `req.id` bằng `resolveRequestId` (LoggerModule) — luôn là string, trùng header
 * `x-request-id`. Thiếu nghĩa là cấu hình hỏng → báo lỗi rõ thay vì trả `requestId` rỗng.
 */
function requestIdOf(request: Request): string {
  const id = (request as Request & { id?: unknown }).id;
  if (typeof id !== 'string')
    throw new Error('req.id chưa có — LoggerModule (pino-http) phải chạy');
  return id;
}
