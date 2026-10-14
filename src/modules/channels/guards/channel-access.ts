import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ChannelVisibility } from '../../../infra/database/schema/index.js';
import type { ChannelAccessContext } from '../channel.policy.js';

/** Do `ChannelAccessGuard` gắn vào `req.channelAccess`. Đủ để gọi policy, KHÔNG đủ để hiển thị. */
export interface ChannelAccess extends ChannelAccessContext {
  orgId: string;
  userId: string;
  channel: { id: string; visibility: ChannelVisibility; archivedAt: Date | null };
}

declare global {
  // oxlint-disable-next-line typescript/no-namespace -- cú pháp bắt buộc để mở rộng namespace Express
  namespace Express {
    interface Request {
      channelAccess?: ChannelAccess;
    }
  }
}

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
