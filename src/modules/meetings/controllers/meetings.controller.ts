import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../../common/auth/auth.types.js';
import { CurrentUser } from '../../../common/auth/current-user.decorator.js';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../../common/swagger/api-paginated-response.decorator.js';
import { CurrentOrgMembership } from '../../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import { UserAuditCtx } from '../../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { ListMeetingsQueryDto } from '../dto/list-meetings-query.dto.js';
import { UpdateMeetingDto } from '../dto/update-meeting.dto.js';
import { MeetingShareResponseDto, ShareMeetingDto } from '../dto/meeting-share.dto.js';
import { MeetingDetailResponseDto, MeetingResponseDto } from '../dto/meeting-response.dto.js';
import { MeetingSummaryResponseDto } from '../dto/meeting-summary.dto.js';
import { TranscriptSegmentResponseDto } from '../dto/meeting-transcript.dto.js';
import { MeetingManagementService } from '../services/meeting-management.service.js';
import { MeetingSharesService } from '../services/meeting-shares.service.js';
import { MeetingsService } from '../services/meetings.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/meetings')
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    private readonly shares: MeetingSharesService,
    private readonly management: MeetingManagementService,
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
   * Transcript của cuộc họp.
   *
   * @remarks Người xem được cuộc họp (như chi tiết). Đoạn theo thứ tự `seq`; chưa xử lý xong → mảng
   * rỗng. Người không xem được nhận 404.
   */
  @Get(':meetingId/transcript')
  @RequireOrgPermission('org.meeting.read')
  @ApiPaginatedResponse(TranscriptSegmentResponseDto)
  @ApiErrorResponses(400)
  async transcript(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: CursorQueryDto,
  ): Promise<Page<TranscriptSegmentResponseDto>> {
    return this.meetings.transcript(membership, user.id, meetingId, query);
  }

  /**
   * Tóm tắt AI của cuộc họp.
   *
   * @remarks Người xem được cuộc họp. Chưa xử lý xong → 409 `MEETING_NOT_COMPLETED`.
   */
  @Get(':meetingId/summary')
  @RequireOrgPermission('org.meeting.read')
  @ApiErrorResponses(400, 409)
  async summary(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<MeetingSummaryResponseDto> {
    return this.meetings.summary(membership, user.id, meetingId);
  }

  /**
   * Chạy lại xử lý cuộc họp bị lỗi.
   *
   * @remarks Cùng quyền như sửa. Chỉ khi `status = failed` (khác → 409 `MEETING_NOT_FAILED`):
   * `attempt` tăng 1, về `queued` và xử lý lại từ đầu (202).
   */
  @Post(':meetingId/retry')
  @RequireOrgPermission('org.meeting.manage')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiErrorResponses(400, 403, 409)
  async retry(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
  ): Promise<MeetingDetailResponseDto> {
    await this.management.retry(membership, ctx, meetingId);
    return this.meetings.getVisible(membership, ctx.actorId, meetingId);
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
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @Body() dto: ShareMeetingDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeetingShareResponseDto> {
    const { share, created } = await this.shares.share(
      membership,
      ctx.actorId,
      meetingId,
      dto.channelId,
      ctx.requestId ?? null,
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

  /**
   * Sửa tiêu đề / thời điểm họp.
   *
   * @remarks Chủ cuộc họp; cuộc họp không còn chủ thì Owner / Admin tổ chức. Xem được nhưng không
   * có quyền → 403; không xem được → 404.
   */
  @Patch(':meetingId')
  @RequireOrgPermission('org.meeting.manage')
  @ApiErrorResponses(400, 403)
  async update(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @Body() dto: UpdateMeetingDto,
  ): Promise<MeetingDetailResponseDto> {
    await this.management.update(membership, ctx, meetingId, dto);
    return this.meetings.getVisible(membership, ctx.actorId, meetingId);
  }

  /**
   * Xoá cuộc họp (xoá mềm).
   *
   * @remarks Cùng quyền như sửa. Cuộc họp biến mất với mọi người, kể cả khỏi các kênh đã chia sẻ.
   * Owner / Admin tổ chức xoá cuộc họp không còn chủ thì được ghi audit.
   */
  @Delete(':meetingId')
  @RequireOrgPermission('org.meeting.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiErrorResponses(400, 403)
  async remove(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
  ): Promise<void> {
    await this.management.remove(membership, ctx, meetingId);
  }
}
