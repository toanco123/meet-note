import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Errors } from '../../common/errors/errors.js';

type ThrottlerLimitDetail = Parameters<ThrottlerGuard['throwThrottlingException']>[1];

/**
 * Rate limit toàn cục (M11 B3). Đăng ký bằng `APP_GUARD` NGAY SAU `JwtAuthGuard` (AuthModule) —
 * cùng mảng providers nên thứ tự chắc chắn — để thấy `req.user` và khoá theo người dùng.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    // APP_GUARD chạy cả cho từng message WebSocket (M7) — rate limit ở đây chỉ dành cho HTTP.
    if (context.getType() !== 'http') return true;
    return super.canActivate(context);
  }

  /**
   * Đã đăng nhập → theo người dùng (nhiều người sau cùng một NAT không giành giới hạn của nhau).
   * Chưa → theo IP qua `super` (gom IPv6 theo subnet: xoay địa chỉ trong một /64 không thoát được).
   */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = (req as unknown as Request).user;
    return user ? `user:${user.id}` : `ip:${await super.getTracker(req)}`;
  }

  /** Lỗi theo catalog (body chuẩn) + `Retry-After` chuẩn — throttler có tên chỉ đặt `Retry-After-<tên>`. */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(detail.timeToBlockExpire));
    throw Errors.common.rateLimited();
  }
}
