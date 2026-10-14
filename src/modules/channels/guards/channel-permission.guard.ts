import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { assertChannelDecision } from '../channel.errors.js';
import { type ChannelPermission, decideChannelPermission } from '../channel.policy.js';

export const CHANNEL_PERMISSION_KEY = 'meetnote:channelPermission';

/**
 * Tầng 4: vai trò được làm LOẠI hành động này không (403), kênh lưu trữ có chặn không (409).
 * Đây chỉ là từ chối NHANH — service kiểm tra lại cùng hàm đó sau khi khoá dòng kênh.
 */
@Injectable()
export class ChannelPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.get<ChannelPermission | undefined>(
      CHANNEL_PERMISSION_KEY,
      context.getHandler(),
    );
    const access = context.switchToHttp().getRequest<Request>().channelAccess;
    if (!permission || !access) {
      throw new Error(
        'ChannelPermissionGuard thiếu permission hoặc channelAccess — dùng @RequireChannelPermission()',
      );
    }

    assertChannelDecision(decideChannelPermission(permission, access));
    return true;
  }
}
