import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgMembershipContext } from '../organization.policy.js';

// Declaration merging: `req.orgMembership` có kiểu ở mọi nơi (do OrgMemberGuard gắn).
declare global {
  // oxlint-disable-next-line typescript/no-namespace -- cú pháp bắt buộc để mở rộng namespace Express
  namespace Express {
    interface Request {
      orgMembership?: OrgMembershipContext;
    }
  }
}

/**
 * Lấy membership của người gọi trong org trên path: `handler(@CurrentOrgMembership() m)`.
 * Chỉ dùng trên route có `@RequireOrgPermission(...)` (guard mới gắn membership).
 */
export const CurrentOrgMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgMembershipContext => {
    const membership = ctx.switchToHttp().getRequest<Request>().orgMembership;
    if (!membership) {
      throw new Error('@CurrentOrgMembership() dùng trên route thiếu @RequireOrgPermission()');
    }
    return membership;
  },
);
