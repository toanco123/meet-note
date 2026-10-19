import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, concatMap, from, type Observable, of, throwError } from 'rxjs';
import { Errors } from '../../common/errors/errors.js';
import {
  decideExisting,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  parseIdempotencyKey,
  requestHash,
} from './idempotency-key.js';
import { IdempotencyRepository } from './idempotency.repository.js';
import type { IdempotencyClaim, IdempotentRequest } from './idempotency.types.js';

/** Dòng có thể biến mất giữa lúc giữ chỗ hụt và lúc đọc (request đầu lỗi → xoá chỗ) → thử lại. */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Header `Idempotency-Key` cho POST không tự idempotent (M5 Q3). Gắn bằng `@Idempotent()`.
 *
 * 1. Không có header → chạy bình thường.
 * 2. Giữ chỗ `(user, key)` ở trạng thái `processing` (một câu SQL nguyên tử, xem repository).
 * 3. Giữ được → chạy handler → lưu status + body → `completed`. Handler lỗi → xoá chỗ giữ.
 * 4. Không giữ được → đã có người: cùng nội dung + đã xong → trả lại response cũ; chưa xong → 409;
 *    nội dung khác → 422.
 *
 * Vị trí trong chuỗi Nest: SAU guard (đã có `req.user`, người ngoài tổ chức bị 404 trước khi đụng
 * tới bảng), TRƯỚC pipe (lỗi validate cũng đi qua `catchError` → xoá chỗ giữ), BÊN TRONG
 * `ResponseEnvelopeInterceptor` (global) → lưu `data` thô, khi trả lại được bọc với `requestId` MỚI.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly repo: IdempotencyRepository) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const key = parseIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
    if (key === undefined) return next.handle();
    // Key theo TỪNG user: không có user thì hai người khác nhau có thể đụng key của nhau.
    if (!req.user) throw new Error('@Idempotent() chỉ dùng cho route đã đăng nhập');

    const request: IdempotentRequest = {
      userId: req.user.id,
      key,
      method: req.method,
      path: req.originalUrl,
      requestHash: requestHash(req.method, req.originalUrl, req.body),
    };
    const claim = await this.claim(request);

    if (claim.kind === 'replay') {
      res.status(claim.status);
      res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return of(claim.body ?? undefined);
    }

    const { claimedAt } = claim;
    return next.handle().pipe(
      concatMap(async (result: unknown) => {
        await this.save(request, claimedAt, res.statusCode, result);
        return result;
      }),
      catchError((error: unknown) =>
        from(this.release(request, claimedAt)).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }

  private async claim(request: IdempotentRequest): Promise<IdempotencyClaim> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const claimedAt = await this.repo.claim(request);
      if (claimedAt !== undefined) return { kind: 'claimed', claimedAt };

      const existing = await this.repo.find(request.userId, request.key);
      if (!existing) continue;
      const decision = decideExisting(existing, request.requestHash);
      if (decision.kind === 'reused') throw Errors.idempotency.reused();
      if (decision.kind === 'in-progress') throw Errors.idempotency.inProgress();
      return decision;
    }
    throw Errors.idempotency.inProgress();
  }

  /**
   * Lưu lỗi thì KHÔNG ném: thao tác đã chạy xong, client phải nhận kết quả. Dòng còn `processing`
   * → request gửi lại nhận 409 tới khi hết lease, rồi được giữ chỗ lại.
   */
  private async save(
    request: IdempotentRequest,
    claimedAt: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    try {
      const saved = await this.repo.complete(request, claimedAt, status, body);
      if (!saved) {
        this.logger.warn(
          { userId: request.userId, path: request.path },
          'Idempotency-Key bị chiếm chỗ (quá lease) trước khi lưu response — bỏ qua bản này',
        );
      }
    } catch (error) {
      this.logger.error({ err: error, userId: request.userId }, 'Lưu response idempotency lỗi');
    }
  }

  /** Xoá chỗ giữ lỗi thì log và để lỗi GỐC của handler đi tiếp (lỗi phụ không che lỗi chính). */
  private async release(request: IdempotentRequest, claimedAt: string): Promise<void> {
    try {
      await this.repo.release(request, claimedAt);
    } catch (error) {
      this.logger.error({ err: error, userId: request.userId }, 'Xoá chỗ giữ idempotency lỗi');
    }
  }
}
