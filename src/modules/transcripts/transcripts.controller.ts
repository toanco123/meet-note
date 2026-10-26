import { Controller, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { RateLimit } from '../../infra/rate-limit/rate-limits.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { RawResponse } from '../../common/response/response-envelope.js';
import { ExportTranscriptQueryDto } from './dto/export-transcript-query.dto.js';
import { SearchTranscriptsQueryDto } from './dto/search-transcripts-query.dto.js';
import { TranscriptSearchResultResponseDto } from './dto/transcript-search-result.dto.js';
import { TranscriptsService } from './transcripts.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId')
export class TranscriptsController {
  constructor(private readonly transcripts: TranscriptsService) {}

  /**
   * Tìm trong transcript các cuộc họp bạn xem được, mới họp trước.
   *
   * @remarks Mỗi kết quả là một cuộc họp kèm tối đa 3 đoạn khớp đầu (mốc thời gian + đoạn trích).
   * Chỉ tìm trong cuộc họp bạn xem được (cùng điều kiện với danh sách cuộc họp); lọc `channelId` cần
   * đọc được nội dung kênh đó. Tìm không dấu ra có dấu. Giới hạn 60 lần / phút.
   */
  @Get('search/transcripts')
  @RequireOrgPermission('org.meeting.read')
  @Throttle(RateLimit.transcriptSearch)
  @ApiPaginatedResponse(TranscriptSearchResultResponseDto)
  @ApiErrorResponses(400, 403)
  async search(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Query() query: SearchTranscriptsQueryDto,
  ): Promise<Page<TranscriptSearchResultResponseDto>> {
    return this.transcripts.search(membership, user.id, query);
  }

  /**
   * Tải transcript dạng phụ đề SRT hoặc VTT.
   *
   * @remarks Cần xem được cuộc họp (không xem được → 404) và cuộc họp đã `completed` (chưa xong →
   * 409). File được stream theo lô nên họp dài không tốn bộ nhớ. Giới hạn 30 lần / phút.
   */
  @Get('meetings/:meetingId/transcript/export')
  @RequireOrgPermission('org.meeting.read')
  @Throttle(RateLimit.transcriptExport)
  @RawResponse()
  @ApiProduces('application/x-subrip', 'text/vtt')
  @ApiOkResponse({ description: 'File phụ đề.', schema: { type: 'string', format: 'binary' } })
  @ApiErrorResponses(400, 403, 409)
  async export(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @CurrentUser() user: AuthUser,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Query() query: ExportTranscriptQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.transcripts.exportSubtitles(
      membership,
      user.id,
      meetingId,
      query.format,
    );
    // Transcript là nội dung nhạy cảm: không để proxy / trình duyệt dùng chung giữ bản sao.
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(file.stream, {
      type: file.contentType,
      disposition: file.contentDisposition,
    });
  }
}
