import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { Page } from '../../common/pagination/cursor.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organization.policy.js';
import { ChannelsService } from './channels.service.js';
import { CreateChannelDto, UpdateChannelDto } from './dto/channel-input.dto.js';
import { ChannelResponseDto } from './dto/channel-response.dto.js';
import { ListChannelsQueryDto } from './dto/list-channels-query.dto.js';
import { type ChannelAccess, CurrentChannelAccess } from './guards/channel-access.js';
import { RequireChannelPermission } from './guards/require-channel-permission.decorator.js';

@ApiTags('Channels')
@Controller('orgs/:orgId/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  /**
   * Tạo kênh. Người tạo trở thành Chủ kênh.
   *
   * @remarks Tên trùng (không phân biệt hoa thường) với kênh khác trong tổ chức → 409
   * `CHANNEL_NAME_TAKEN`. Tên của kênh đã xoá được dùng lại.
   */
  @Post()
  @RequireOrgPermission('org.channel.create')
  @ApiErrorResponses(400, 409)
  async create(
    @Param('orgId') orgId: string,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: CreateChannelDto,
  ): Promise<ChannelResponseDto> {
    return ChannelResponseDto.from(await this.channels.create(orgId, dto, audit));
  }

  /**
   * Danh sách kênh tôi thấy được.
   *
   * @remarks Thành viên: kênh công khai + kênh riêng tư mình tham gia. Owner/Admin tổ chức: mọi
   * kênh (chỉ metadata). Sắp theo tên A→Z; `q` tìm không dấu. Mặc định ẩn kênh đã lưu trữ.
   */
  @Get()
  @RequireOrgPermission('org.channel.list')
  @ApiPaginatedResponse(ChannelResponseDto)
  @ApiErrorResponses(400)
  list(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Query() query: ListChannelsQueryDto,
  ): Promise<Page<ChannelResponseDto>> {
    return this.channels.list(membership, user.id, query);
  }

  /**
   * Chi tiết kênh.
   *
   * @remarks Kênh riêng tư mà bạn không phải thành viên (và không phải Owner/Admin tổ chức) → 404.
   */
  @Get(':channelId')
  @RequireChannelPermission('channel.read')
  async get(@CurrentChannelAccess() access: ChannelAccess): Promise<ChannelResponseDto> {
    return ChannelResponseDto.from(await this.channels.getDetail(access.channel.id, access.userId));
  }

  /**
   * Sửa kênh (Chủ kênh, QTV kênh).
   *
   * @remarks Chỉ field gửi lên mới được đổi. Kênh đã lưu trữ → 409 `CHANNEL_ARCHIVED`; tên trùng
   * → 409 `CHANNEL_NAME_TAKEN`.
   */
  @Patch(':channelId')
  @RequireChannelPermission('channel.update')
  @ApiErrorResponses(400)
  async update(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: UpdateChannelDto,
  ): Promise<ChannelResponseDto> {
    const detail = await this.channels.update(
      access,
      {
        name: dto.name,
        description: dto.description,
        visibility: dto.visibility,
        weeklyReportEnabled: dto.weeklyReportEnabled,
      },
      audit,
    );
    return ChannelResponseDto.from(detail);
  }
}
