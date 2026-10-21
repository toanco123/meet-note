import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../../common/auth/auth.types.js';
import { CurrentUser } from '../../../common/auth/current-user.decorator.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../../common/swagger/api-paginated-response.decorator.js';
import { CurrentOrgMembership } from '../../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import { ListMeetingsQueryDto } from '../dto/list-meetings-query.dto.js';
import { MeetingShareResponseDto, ShareMeetingDto } from '../dto/meeting-share.dto.js';
import { MeetingDetailResponseDto, MeetingResponseDto } from '../dto/meeting-response.dto.js';
import { MeetingSharesService } from '../services/meeting-shares.service.js';
import { MeetingsService } from '../services/meetings.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/meetings')
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    private readonly shares: MeetingSharesService,
  ) {}

  /**
   * Danh sách cuộc họp bạn xem được, mới họp trước.
   *
   * @remarks Gồm: cuộc họp của bạn, cuộc họp được chia sẻ vào kênh bạn là thành viên hoặc kênh công
   * khai, và (Owner / Admin tổ chức) cuộc họp không còn chủ. Lọc `channelId` cần đọc được nội dung
   * kênh đó.
   */
  @Get()
  @RequireOrgPermission('org.meeting.read')
  @ApiPaginatedResponse(MeetingResponseDto)
  @ApiErrorResponses(400, 403)
  async list(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Query() query: ListMeetingsQueryDto,
  ): Promise<Page<MeetingResponseDto>> {
    return this.meetings.list(membership, user.id, query);
  }

  /**
   * Chi tiết cuộc họp.
   *
   * @remarks Người không xem được nhận 404 (như không tồn tại). `channels`: các kênh chứa cuộc họp
   * mà bạn thấy được.
   */
  @Get(':meetingId')
  @RequireOrgPermission('org.meeting.read')
  @ApiErrorResponses(400)
  async get(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<MeetingDetailResponseDto> {
    return this.meetings.getVisible(membership, user.id, meetingId);
  }

  /**
   * Chia sẻ cuộc họp của bạn vào một kênh.
   *
   * @remarks Bạn phải là thành viên kênh (Chủ kênh / QTV / Thành viên; khách không được). Kênh lưu
   * trữ → 409. Chia sẻ lại → 200 với đúng bản ghi cũ (lần đầu 201).
   */
  @Post(':meetingId/shares')
  @RequireOrgPermission('org.meeting.manage')
  @ApiErrorResponses(400, 403, 409)
  async share(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @Body() dto: ShareMeetingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeetingShareResponseDto> {
    const { share, created } = await this.shares.share(
      membership,
      user.id,
      meetingId,
      dto.channelId,
    );
    if (!created) res.status(HttpStatus.OK);
    return share;
  }

  /**
   * Gỡ cuộc họp khỏi kênh.
   *
   * @remarks Chủ cuộc họp (kể cả khi đã rời kênh), Chủ kênh / QTV kênh; cuộc họp không còn chủ thì
   * Owner / Admin tổ chức. Kênh lưu trữ → 409. Gọi lại → 204.
   */
  @Delete(':meetingId/shares/:channelId')
  @RequireOrgPermission('org.meeting.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiErrorResponses(400, 403, 409)
  async unshare(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @Param('channelId', new ParseUUIDPipe()) channelId: string,
  ): Promise<void> {
    await this.shares.unshare(membership, user.id, meetingId, channelId);
  }
}
