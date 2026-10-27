import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
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
import { UserAuditCtx } from '../audit/audit-context.decorator.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { TranscriptSegmentResponseDto } from '../meetings/dto/meeting-transcript.dto.js';
import { EditSegmentDto } from './dto/edit-segment.dto.js';
import { IfMatchVersion } from './if-match.js';
import { ParseSegmentSeqPipe } from './segment-seq.pipe.js';
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
  /**
   * Sửa nội dung một đoạn transcript.
   *
   * @remarks Chủ cuộc họp (cuộc họp không còn chủ: Owner / Admin tổ chức); cuộc họp phải `completed`.
   * Bắt buộc header `If-Match` mang version của đoạn bạn đã đọc (`version` trong `GET …/transcript`,
   * hoặc `ETag` của lần sửa trước). Có người sửa trước bạn → 412, tải lại đoạn rồi sửa tiếp; thiếu
   * header → 428. Thành công trả đoạn mới kèm `ETag`. Tóm tắt AI không tự cập nhật theo bản sửa.
   * Giới hạn 120 lần / phút.
   */
  @Patch('meetings/:meetingId/transcript/segments/:seq')
  @RequireOrgPermission('org.meeting.manage')
  @Throttle(RateLimit.transcriptEdit)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Version hiện tại của đoạn, dạng `"3"` (giá trị `ETag` / `version`).',
  })
  @ApiErrorResponses(400, 403, 404, 409, 412, 428)
  async editSegment(
    @CurrentOrgMembership() membership: OrgMembershipContext,
    @UserAuditCtx() ctx: UserAuditContext,
    @Param('meetingId', ParseUUIDPipe) meetingId: string,
    @Param('seq', ParseSegmentSeqPipe) seq: number,
    @IfMatchVersion() expectedVersion: number,
    @Body() dto: EditSegmentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TranscriptSegmentResponseDto> {
    const segment = await this.transcripts.editSegment(
      membership,
      ctx,
      meetingId,
      seq,
      expectedVersion,
      dto.text,
    );
    res.setHeader('ETag', `"${segment.version}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return TranscriptSegmentResponseDto.from(segment);
  }
}
