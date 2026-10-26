import { Injectable } from '@nestjs/common';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { MeetingsService, viewerOf } from '../meetings/services/meetings.service.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { SearchTranscriptsQueryDto } from './dto/search-transcripts-query.dto.js';
import { TranscriptSearchResultResponseDto } from './dto/transcript-search-result.dto.js';
import { TranscriptsRepository } from './transcripts.repository.js';

/** Số đoạn khớp hiển thị cho mỗi meeting (M8 Q3). */
const HITS_PER_MEETING = 3;

@Injectable()
export class TranscriptsService {
  constructor(
    private readonly repo: TranscriptsRepository,
    private readonly meetings: MeetingsService,
  ) {}

  async search(
    membership: OrgMembershipContext,
    userId: string,
    query: SearchTranscriptsQueryDto,
  ): Promise<Page<TranscriptSearchResultResponseDto>> {
    if (query.channelId) {
      await this.meetings.assertChannelContentReadable(membership, userId, query.channelId);
    }
    const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
    const rows = await this.repo.searchMeetings({
      orgId: membership.orgId,
      viewer: viewerOf(membership, userId),
      query: query.q,
      channelId: query.channelId,
      after: after && { recordedAt: expectTimestampKey(after[0]), id: expectUuidKey(after[1]) },
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.recordedAtKey, row.id]);
    const hits = await this.repo.findHits(
      membership.orgId,
      page.data.map((m) => m.id),
      query.q,
      HITS_PER_MEETING,
    );
    return {
      data: page.data.map((row) =>
        TranscriptSearchResultResponseDto.from(
          row,
          hits.filter((h) => h.meetingId === row.id),
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
