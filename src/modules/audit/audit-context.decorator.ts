import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditContext, UserAuditContext } from './audit.types.js';

/**
 * `handler(@AuditCtx() audit: AuditContext)` — gom actor (từ JwtAuthGuard), request id (pino-http
 * gắn `req.id`, trùng header x-request-id) và IP của request. Route @Public → actorId = null.
 */
export const AuditCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuditContext => {
    const request = ctx.switchToHttp().getRequest<Request & { id?: unknown }>();
    return {
      actorId: request.user?.id ?? null,
      requestId: typeof request.id === 'string' ? request.id : null,
      ip: request.ip ?? null,
    };
  },
);

/**
 * Như `@AuditCtx()` nhưng BẮT BUỘC có người dùng — dùng trên route cần đăng nhập để kiểu `actorId`
 * là `string` (không phải `string | null`). Thiếu user = lỗi cấu hình (route @Public) → 500.
 */
export const UserAuditCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserAuditContext => {
    const request = ctx.switchToHttp().getRequest<Request & { id?: unknown }>();
    if (!request.user) throw new Error('@UserAuditCtx() dùng trên route không qua JwtAuthGuard');
    return {
      actorId: request.user.id,
      requestId: typeof request.id === 'string' ? request.id : null,
      ip: request.ip ?? null,
    };
  },
);
