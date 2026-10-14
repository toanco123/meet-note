import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination/cursor.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { ChannelMembersService } from './channel-members.service.js';
import {
  AddChannelMemberDto,
  ChannelMemberResponseDto,
  ListChannelMembersQueryDto,
  UpdateChannelMemberRoleDto,
} from './dto/channel-member.dto.js';
import { type ChannelAccess, CurrentChannelAccess } from './guards/channel-access.js';
import { RequireChannelPermission } from './guards/require-channel-permission.decorator.js';

@ApiTags('Channels')
@Controller('orgs/:orgId/channels/:channelId/members')
export class ChannelMembersController {
  constructor(private readonly members: ChannelMembersService) {}

  /**
   * Danh sách thành viên kênh.
   *
   * @remarks Khách không xem được (403). Phân trang theo thời điểm tham gia; `q` tìm không dấu
   * theo tên/email.
   */
  @Get()
  @RequireChannelPermission('channel.member.list')
  @ApiPaginatedResponse(ChannelMemberResponseDto)
  @ApiErrorResponses(400)
  list(
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: ListChannelMembersQueryDto,
  ): Promise<Page<ChannelMemberResponseDto>> {
    return this.members.list(access.channel.id, query);
  }

  /**
   * Thêm thành viên tổ chức vào kênh (Chủ kênh, QTV kênh).
   *
   * @remarks QTV chỉ thêm được `member` / `guest`. Người không thuộc tổ chức → 404; đã ở trong
   * kênh → 409 `CHANNEL_ALREADY_MEMBER`.
   */
  @Post()
  @RequireChannelPermission('channel.member.add')
  @ApiErrorResponses(400)
  async add(
    @CurrentChannelAccess() access: ChannelAccess,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: AddChannelMemberDto,
  ): Promise<ChannelMemberResponseDto> {
    return ChannelMemberResponseDto.from(
      await this.members.add(access, dto.userId, dto.role, audit),
    );
  }

  /**
   * Đổi vai trò thành viên kênh.
   *
   * @remarks Chủ kênh đổi được mọi người; QTV chỉ đổi qua lại `member` ↔ `guest`. Đổi vai trò Chủ
   * kênh → 409 `CHANNEL_OWNER_IMMUTABLE` (dùng chuyển chủ kênh).
   */
  @Patch(':userId')
  @RequireChannelPermission('channel.member.role.change')
  @ApiErrorResponses(400)
  async changeRole(
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UserAuditCtx() audit: UserAuditContext,
    @Body() dto: UpdateChannelMemberRoleDto,
  ): Promise<ChannelMemberResponseDto> {
    return ChannelMemberResponseDto.from(
      await this.members.changeRole(access, userId, dto.role, audit),
    );
  }

  /**
   * Gỡ thành viên khỏi kênh.
   *
   * @remarks Chủ kênh gỡ được mọi người trừ mình; QTV chỉ gỡ `member` / `guest`. Tự rời kênh là
   * chức năng riêng (`POST .../leave`).
   */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireChannelPermission('channel.member.remove')
  @ApiNoContentResponse({ description: 'Đã gỡ khỏi kênh.' })
  @ApiErrorResponses(400)
  async remove(
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UserAuditCtx() audit: UserAuditContext,
  ): Promise<void> {
    await this.members.remove(access, userId, audit);
  }
}
