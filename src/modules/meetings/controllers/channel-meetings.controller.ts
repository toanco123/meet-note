import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import { ApiPaginatedResponse } from '../../../common/swagger/api-paginated-response.decorator.js';
import type { ChannelAccess } from '../../channels/channels.types.js';
import { CurrentChannelAccess } from '../../channels/guards/channel-access.js';
import { RequireChannelPermission } from '../../channels/guards/require-channel-permission.decorator.js';
import { ChannelMeetingResponseDto } from '../dto/meeting-response.dto.js';
import { MeetingsService } from '../services/meetings.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/channels/:channelId/meetings')
export class ChannelMeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  /**
   * Cuộc họp được chia sẻ vào kênh, mới chia sẻ trước.
   *
   * @remarks Cần đọc được nội dung kênh: thành viên kênh, hoặc thành viên tổ chức với kênh công khai
   * (kể cả đã lưu trữ). Owner / Admin tổ chức không ở trong kênh riêng tư → 403.
   */
  @Get()
  @RequireChannelPermission('channel.content.read')
  @ApiPaginatedResponse(ChannelMeetingResponseDto)
  async list(
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: CursorQueryDto,
  ): Promise<Page<ChannelMeetingResponseDto>> {
    return this.meetings.listByChannel(access, query);
  }
}
