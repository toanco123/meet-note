import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import { MeetingResponseDto } from './dto/meeting-response.dto.js';
import { MeetingsService } from './meetings.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  /**
   * Chi tiết cuộc họp.
   *
   * @remarks M5: chỉ chủ cuộc họp xem được (để theo dõi trạng thái sau khi upload); người khác
   * nhận 404. M6 mở rộng cho người xem được qua kênh.
   */
  @Get(':meetingId')
  @RequireOrgPermission('org.meeting.read')
  @ApiErrorResponses(400)
  async get(
    @Param('orgId') orgId: string,
    @Param('meetingId', new ParseUUIDPipe()) meetingId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<MeetingResponseDto> {
    return MeetingResponseDto.from(await this.meetings.getOwned(orgId, user.id, meetingId));
  }
}
