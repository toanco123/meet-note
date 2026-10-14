import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ChannelAccess } from '../channels.types.js';

/** `handler(@CurrentChannelAccess() access)` — chỉ dùng trên route có `@RequireChannelPermission()`. */
export const CurrentChannelAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ChannelAccess => {
    const access = ctx.switchToHttp().getRequest<Request>().channelAccess;
    if (!access) {
      throw new Error('@CurrentChannelAccess() dùng trên route thiếu @RequireChannelPermission()');
    }
    return access;
  },
);
