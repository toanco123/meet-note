import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isUuid } from '../../../common/validation/uuid.js';
import { Errors } from '../../../common/errors/errors.js';
import { channelPolicy } from '../channel.policy.js';
import { ChannelsRepository } from '../repositories/channels.repository.js';
import type { ChannelAccess } from '../channels.types.js';

/**
 * Tầng 3: người gọi có được THẤY kênh `:channelId` không? Gắn `req.channelAccess`.
 *
 * - `:channelId` không phải uuid / không thuộc org trên path / đã xoá → 404.
 * - Riêng tư mà không phải thành viên kênh và không phải OrgAdm → **404**, không 403: trả 403 là
 *   xác nhận "kênh này có tồn tại", đủ để dò tên kênh riêng tư của người khác.
 * - "Thấy được" chính là permission `channel.read` của policy → một nguồn sự thật, không viết lại.
 */
@Injectable()
export class ChannelAccessGuard implements CanActivate {
  constructor(private readonly repo: ChannelsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const { user, orgMembership } = request;
    if (!user || !orgMembership) {
      throw new Error('ChannelAccessGuard cần JwtAuthGuard + OrgMemberGuard chạy trước');
    }

    const channelId = request.params['channelId'];
    if (!isUuid(channelId)) throw Errors.channel.notFound();

    const row = await this.repo.findAccess(orgMembership.orgId, channelId, user.id);
    if (!row) throw Errors.channel.notFound();

    const access: ChannelAccess = {
      orgId: orgMembership.orgId,
      userId: user.id,
      orgRole: orgMembership.role,
      channelRole: row.channelRole,
      channel: { id: row.id, visibility: row.visibility, archivedAt: row.archivedAt },
    };
    if (!channelPolicy['channel.read'](access)) throw Errors.channel.notFound();

    request.channelAccess = access;
    return true;
  }
}
