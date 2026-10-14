import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../../common/auth/auth.types.js';
import { CurrentUser } from '../../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { CurrentOrgMembership } from '../../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../../organizations/guards/require-org-permission.decorator.js';
import { ChannelMembersService } from '../services/channel-members.service.js';
import { ChannelsService } from '../services/channels.service.js';
import {
  ChannelOwnershipTransferResponseDto,
  TransferChannelOwnershipDto,
} from '../dto/channel-ownership.dto.js';
import { CreateChannelDto, UpdateChannelDto } from '../dto/channel-input.dto.js';
import { ChannelResponseDto } from '../dto/channel-response.dto.js';
import { ListChannelsQueryDto } from '../dto/list-channels-query.dto.js';
import { CurrentChannelAccess } from '../guards/channel-access.js';
import { RequireChannelPermission } from '../guards/require-channel-permission.decorator.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import type { ChannelAccess } from '../channels.types.js';

@ApiTags('Channels')
@Controller('orgs/:orgId/channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    private readonly members: ChannelMembersService,
  ) {}

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

  /**
   * Tự tham gia kênh công khai (thành viên).
   *
   * @remarks Đã ở trong kênh → 409 `CHANNEL_ALREADY_MEMBER`. Kênh riêng tư không tự tham gia được
   * (phải được thêm); kênh lưu trữ → 409 `CHANNEL_ARCHIVED`.
   */
  @Post(':channelId/join')
  @HttpCode(HttpStatus.OK)
  @RequireChannelPermission('channel.join')
  async join(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<ChannelResponseDto> {
    await this.members.join(access, audit);
    return ChannelResponseDto.from(await this.channels.getDetail(access.channel.id, access.userId));
  }

  /**
   * Rời kênh.
   *
   * @remarks Chủ kênh phải chuyển chủ kênh trước → 409 `CHANNEL_OWNER_MUST_TRANSFER`. Kênh đã lưu
   * trữ vẫn rời được.
   */
  @Post(':channelId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireChannelPermission('channel.leave')
  @ApiNoContentResponse({ description: 'Đã rời kênh.' })
  @ApiErrorResponses(409)
  async leave(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<void> {
    await this.members.leave(access, audit);
  }

  /**
   * Chuyển chủ kênh (Chủ kênh, hoặc Owner/Admin tổ chức chuyển hộ).
   *
   * @remarks Người nhận phải là thành viên kênh (không phải → 404) và không phải Khách (→ 409
   * `CHANNEL_TRANSFER_INVALID_TARGET`, cũng trả khi người nhận đã là chủ). Chủ cũ thành QTV kênh.
   */
  @Post(':channelId/ownership-transfer')
  @HttpCode(HttpStatus.OK)
  @RequireChannelPermission('channel.ownership.transfer')
  @ApiErrorResponses(400)
  transferOwnership(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: TransferChannelOwnershipDto,
  ): Promise<ChannelOwnershipTransferResponseDto> {
    return this.members.transferOwnership(access, dto.newOwnerId, audit);
  }

  /**
   * Lưu trữ kênh (Chủ kênh, Owner/Admin tổ chức).
   *
   * @remarks Kênh lưu trữ = chỉ đọc: mọi thao tác ghi trả 409 `CHANNEL_ARCHIVED`, trừ rời kênh,
   * bỏ lưu trữ và xoá. Gọi lại khi đã lưu trữ → 200, không đổi gì.
   */
  @Post(':channelId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireChannelPermission('channel.archive')
  async archive(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<ChannelResponseDto> {
    return ChannelResponseDto.from(await this.channels.setArchived(access, true, audit));
  }

  /** Bỏ lưu trữ kênh (Chủ kênh, Owner/Admin tổ chức). Chưa lưu trữ → 200, không đổi gì. */
  @Post(':channelId/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequireChannelPermission('channel.archive')
  async unarchive(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<ChannelResponseDto> {
    return ChannelResponseDto.from(await this.channels.setArchived(access, false, audit));
  }

  /**
   * Xoá kênh (Chủ kênh, Owner/Admin tổ chức).
   *
   * @remarks Xoá mềm: từ giờ mọi người nhận 404, tên kênh dùng lại được ngay. Dữ liệu bị xoá cứng
   * sau 30 ngày.
   */
  @Delete(':channelId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireChannelPermission('channel.delete')
  @ApiNoContentResponse({ description: 'Đã xoá kênh.' })
  async remove(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<void> {
    await this.channels.softDelete(access, audit);
  }
}
