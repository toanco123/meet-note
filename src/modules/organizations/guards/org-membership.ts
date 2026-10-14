import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrgMembershipContext } from '../organizations.types.js';

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
