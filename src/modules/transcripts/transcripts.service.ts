import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { Errors } from '../../common/errors/errors.js';
import { OrgContext } from '../../infra/database/org-context.js';
import { MeetingsService, viewerOf } from '../meetings/services/meetings.service.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { SearchTranscriptsQueryDto } from './dto/search-transcripts-query.dto.js';
import { TranscriptSearchResultResponseDto } from './dto/transcript-search-result.dto.js';
import { contentDisposition } from './transcript-filename.js';
import { coalesce, formatSubtitles, type SubtitleFormat } from './transcript-formats.js';
import { TranscriptsRepository } from './transcripts.repository.js';
import type { SubtitleCue, SubtitleDownload } from './transcripts.types.js';

/** Số đoạn khớp hiển thị cho mỗi meeting (M8 Q3). */
const HITS_PER_MEETING = 3;
/** Số đoạn mỗi lô khi xuất file: đủ lớn để ít vòng khứ hồi, đủ nhỏ để không giữ nhiều trong bộ nhớ. */
const EXPORT_BATCH = 500;

const CONTENT_TYPES: Record<SubtitleFormat, string> = {
  srt: 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
};

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

  /**
   * Xuất transcript thành SRT / VTT, STREAM theo lô: bộ nhớ không phụ thuộc độ dài bản ghi. Quyền =
   * quyền XEM (như `GET transcript`; không xem được → 404). Chưa `completed` → 409 — transcript dở
   * dang (bước transcribe chưa xong) tải về sẽ thiếu mà không báo.
   */
  async exportSubtitles(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
    format: SubtitleFormat,
  ): Promise<SubtitleDownload> {
    const meeting = await this.meetings.assertVisible(membership, userId, meetingId);
    if (meeting.status !== 'completed') throw Errors.meeting.notCompleted();
    const orgId = membership.orgId;
    return {
      contentType: CONTENT_TYPES[format],
      contentDisposition: contentDisposition(meeting.title, meeting.id, format),
      stream: Readable.from(coalesce(formatSubtitles(format, this.cues(orgId, meetingId)))),
    };
  }

  /**
   * Đoạn theo lô keyset `seq`. Generator chạy KHI response đọc stream — có thể ngoài ngữ cảnh async của
   * request — mà `transcript_segments` có RLS theo `app.org_id`: ngữ cảnh mất thì mỗi lô trả 0 dòng,
   * KHÔNG lỗi → file rỗng. Nên bọc từng lô trong `runInOrg` tường minh.
   */
  private async *cues(orgId: string, meetingId: string): AsyncGenerator<SubtitleCue> {
    let afterSeq = -1;
    for (;;) {
      const batch = await OrgContext.runInOrg(
        orgId,
        async () =>
          // `await` TRONG `runInOrg`: truy vấn Drizzle là builder LƯỜI, chỉ chạy khi bị await — trả thẳng
          // builder ra ngoài thì nó thực thi sau khi ngữ cảnh đã đóng (RLS: 0 dòng, không lỗi).
          await this.repo.segmentBatch(meetingId, afterSeq, EXPORT_BATCH),
      );
      yield* batch;
      if (batch.length < EXPORT_BATCH) return;
      afterSeq = batch[batch.length - 1]!.seq;
    }
  }
}
