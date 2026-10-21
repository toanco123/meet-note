import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { ListMeetingsQueryDto } from './dto/list-meetings-query.dto.js';
import { MeetingDetailResponseDto, MeetingResponseDto } from './dto/meeting-response.dto.js';
import { MeetingsService } from './meetings.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

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
}
