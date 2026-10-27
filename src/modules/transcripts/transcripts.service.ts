import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import { Errors } from '../../common/errors/errors.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { OrgContext } from '../../infra/database/org-context.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { AuditService } from '../audit/audit.service.js';
import { MeetingsService, viewerOf } from '../meetings/services/meetings.service.js';
import type { OrgMembershipContext } from '../organizations/organizations.types.js';
import { SearchTranscriptsQueryDto } from './dto/search-transcripts-query.dto.js';
import { TranscriptSearchResultResponseDto } from './dto/transcript-search-result.dto.js';
import { decideTranscriptEdit } from './transcript.policy.js';
import { contentDisposition } from './transcript-filename.js';
import { coalesce, formatSubtitles, type SubtitleFormat } from './transcript-formats.js';
import { TranscriptsRepository } from './transcripts.repository.js';
import type { EditedSegment, SubtitleCue, SubtitleDownload } from './transcripts.types.js';

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
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: TranscriptsRepository,
    private readonly meetings: MeetingsService,
    private readonly audit: AuditService,
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
   * Sửa `text` một đoạn (M13). Thứ tự kiểm tra cố ý: XEM được? (không → 404, không lộ meeting tồn
   * tại) → quyền sửa (403) → đã `completed`? (409) → sửa có điều kiện theo `version` (404 / 412).
   *
   * KHÔNG khoá dòng meeting (khác `MeetingManagementService`): tranh chấp ở đây là giữa hai LẦN SỬA
   * cùng đoạn, và `version` trong WHERE đã phân xử nguyên tử. Hai thứ có thể đổi giữa lúc kiểm tra
   * và lúc ghi — chủ meeting rời org (→ không chủ), meeting bị xoá mềm — đều vô hại: tệ nhất là
   * thêm MỘT lần sửa của người vừa mất quyền vào dữ liệu họ từng sở hữu (cùng cân nhắc với tạo lại
   * báo cáo, M9 bài học 30). Nếu thao tác ghi sau này gây hậu quả không đảo ngược được thì phải khoá.
   *
   * Audit trong CÙNG transaction, chỉ khi người sửa không phải chủ (như `meeting.deleted`), và KHÔNG
   * ghi nội dung đoạn — audit sống lâu hơn transcript.
   */
  async editSegment(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    meetingId: string,
    seq: number,
    expectedVersion: number,
    text: string,
  ): Promise<EditedSegment> {
    const meeting = await this.meetings.assertVisible(membership, ctx.actorId, meetingId);
    const decision = decideTranscriptEdit(meeting, {
      userId: ctx.actorId,
      orgRole: membership.role,
    });
    if (decision === 'forbidden') throw Errors.meeting.notManager();
    if (decision === 'not_completed') throw Errors.transcript.notEditable();

    return await this.db.transaction(async (tx) => {
      const out = await this.repo.editSegment(
        meetingId,
        seq,
        expectedVersion,
        text,
        ctx.actorId,
        tx,
      );
      if (out.kind === 'not_found') throw Errors.transcript.segmentNotFound();
      if (out.kind === 'version_mismatch') throw Errors.transcript.versionMismatch();
      if (meeting.ownerId !== ctx.actorId) {
        await this.audit.record(tx, ctx, {
          orgId: membership.orgId,
          action: 'transcript.segment.edited',
          targetType: 'meeting',
          targetId: meetingId,
          metadata: { seq, fromVersion: expectedVersion, toVersion: out.segment.version },
        });
      }
      return out.segment;
    });
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
