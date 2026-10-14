import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './auth.types.js';

/**
 * Lấy user đã xác thực: `handler(@CurrentUser() user: AuthUser)`.
 *
 * Không có `req.user` nghĩa là lập trình viên dùng decorator này trên route `@Public()` —
 * lỗi của code chứ không phải của client, nên ném Error thường (→ 500) để lộ ra sớm khi test.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) {
      throw new Error(
        '@CurrentUser() được dùng trên route không qua JwtAuthGuard (route @Public?)',
      );
    }
    return user;
  },
);
