import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator.js';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator.js';
import { RateLimit } from '../../infra/rate-limit/rate-limits.js';
import { CurrentOrgMembership } from '../organizations/guards/org-membership.js';
import { RequireOrgPermission } from '../organizations/guards/require-org-permission.decorator.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { SearchTranscriptsQueryDto } from './dto/search-transcripts-query.dto.js';
import { TranscriptSearchResultResponseDto } from './dto/transcript-search-result.dto.js';
import { TranscriptsService } from './transcripts.service.js';

@ApiTags('Meetings')
@Controller('orgs/:orgId/search/transcripts')
export class TranscriptsController {
  constructor(private readonly transcripts: TranscriptsService) {}

  /**
   * Tìm trong transcript các cuộc họp bạn xem được, mới họp trước.
   *
   * @remarks Mỗi kết quả là một cuộc họp kèm tối đa 3 đoạn khớp đầu (mốc thời gian + đoạn trích).
   * Chỉ tìm trong cuộc họp bạn xem được (cùng điều kiện với danh sách cuộc họp); lọc `channelId` cần
   * đọc được nội dung kênh đó. Tìm không dấu ra có dấu. Giới hạn 60 lần / phút.
   */
  @Get()
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
}
