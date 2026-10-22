import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  type MeetingFailureCode,
  type MeetingStatus,
  meetings,
  meetingSummaries,
  transcriptSegments,
  uploads,
} from '../../../infra/database/schema/index.js';
import type { MeetingSummaryContent } from '../../../infra/llm/llm.types.js';
import type { TranscriptSegmentInput } from '../../../infra/speech/speech.types.js';
import type { ClaimedMeeting } from '../meetings.types.js';

/** Postgres giới hạn 65 535 tham số / câu; 1 000 đoạn × 6 cột là vừa, không làm câu quá lớn. */
const SEGMENT_BATCH = 1_000;

/**
 * Truy vấn của pipeline (M6 B4) — chạy trong WORKER (`meetnote_worker_login`, BYPASSRLS).
 *
 * Máy trạng thái bằng LEASE + FENCING TOKEN: `status` là CHẶNG hiện tại (đang chờ hoặc đang chạy);
 * `claim` nhận việc khi chưa ai giữ / lease hết hạn; `complete*` chỉ ghi khi token còn là của mình.
 */
@Injectable()
export class MeetingPipelineRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Nhận việc: MỘT câu UPDATE có điều kiện (không khoá giữ lâu) — đúng `attempt` (job của lần chạy
   * cũ bị loại), chưa xoá, đang ở chặng `from`, và CHƯA AI GIỮ hoặc lease đã hết hạn. Hai worker
   * cùng nhận → câu thứ hai thấy token của câu đầu (Postgres xếp hàng trên khoá dòng) → 0 dòng.
   */
  async claim(
    meetingId: string,
    attempt: number,
    from: MeetingStatus[],
    to: MeetingStatus,
    leaseMs: number,
  ): Promise<ClaimedMeeting | undefined> {
    const [row] = await this.db
      .update(meetings)
      .set({
        status: to,
        stageToken: sql`gen_random_uuid()`,
        stageLeaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.attempt, attempt),
          isNull(meetings.deletedAt),
          inArray(meetings.status, from),
          or(isNull(meetings.stageLeaseUntil), sql`${meetings.stageLeaseUntil} < now()`),
        ),
      )
      .returning({
        id: meetings.id,
        orgId: meetings.orgId,
        ownerId: meetings.ownerId,
        title: meetings.title,
        sourceObjectKey: meetings.sourceObjectKey,
        audioObjectKey: meetings.audioObjectKey,
        durationMs: meetings.durationMs,
        attempt: meetings.attempt,
        stageToken: meetings.stageToken,
      });
    return row ? { ...row, stageToken: row.stageToken as string } : undefined;
  }

  /** Lỗi → nhả lease NGAY để retry (BullMQ) nhận lại, không phải chờ hết hạn. */
  async release(meetingId: string, token: string): Promise<void> {
    await this.db
      .update(meetings)
      .set({ stageToken: null, stageLeaseUntil: null })
      .where(and(eq(meetings.id, meetingId), eq(meetings.stageToken, token)));
  }

  /** Thời lượng preprocess đã đo — để đặt hạn chạy whisper / lease theo độ dài audio. */
  async durationOf(meetingId: string): Promise<number | undefined> {
    const [row] = await this.db
      .select({ durationMs: meetings.durationMs })
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    return row?.durationMs ?? undefined;
  }

  /** sha256 client khai báo lúc khởi tạo upload (M5) — `uploads_meeting_uq`. */
  async expectedSha256(meetingId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ sha256: uploads.sha256 })
      .from(uploads)
      .where(eq(uploads.meetingId, meetingId));
    return row?.sha256;
  }

  /**
   * Chuyển chặng + nhả lease, CHỈ khi token còn là của mình (fencing). `false` = đã mất lease
   * (hết hạn, worker khác nhận) → caller KHÔNG được ghi kết quả.
   */
  private async advance(
    tx: DbExecutor,
    meetingId: string,
    token: string,
    to: MeetingStatus,
    extra: Partial<typeof meetings.$inferInsert> = {},
  ): Promise<boolean> {
    const rows = await tx
      .update(meetings)
      .set({ ...extra, status: to, stageToken: null, stageLeaseUntil: null })
      .where(and(eq(meetings.id, meetingId), eq(meetings.stageToken, token)))
      .returning({ id: meetings.id });
    return rows.length > 0;
  }

  completePreprocess(
    tx: DbExecutor,
    meetingId: string,
    token: string,
    result: { durationMs: number; audioObjectKey: string },
  ): Promise<boolean> {
    return this.advance(tx, meetingId, token, 'transcribing', result);
  }

  completeTranscribe(
    tx: DbExecutor,
    meetingId: string,
    token: string,
    language: string | null,
  ): Promise<boolean> {
    return this.advance(tx, meetingId, token, 'summarizing', { language });
  }

  completeSummarize(tx: DbExecutor, meetingId: string, token: string): Promise<boolean> {
    return this.advance(tx, meetingId, token, 'completed');
  }

  /** Ghi kiểu THAY THẾ: xoá rồi chèn lại theo lô — chạy lại bước transcribe không nhân đôi đoạn. */
  async replaceSegments(
    tx: DbExecutor,
    meeting: { id: string; orgId: string },
    segments: TranscriptSegmentInput[],
  ): Promise<void> {
    await tx.delete(transcriptSegments).where(eq(transcriptSegments.meetingId, meeting.id));
    for (let i = 0; i < segments.length; i += SEGMENT_BATCH) {
      await tx.insert(transcriptSegments).values(
        segments.slice(i, i + SEGMENT_BATCH).map((s, j) => ({
          meetingId: meeting.id,
          orgId: meeting.orgId,
          seq: i + j,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        })),
      );
    }
  }

  segmentsOf(meetingId: string) {
    return this.db
      .select({ startMs: transcriptSegments.startMs, text: transcriptSegments.text })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId))
      .orderBy(asc(transcriptSegments.seq));
  }

  /** Upsert theo `meeting_id` — chạy lại ghi đè, không lỗi trùng khoá. */
  async upsertSummary(
    tx: DbExecutor,
    meeting: { id: string; orgId: string },
    summary: {
      content: MeetingSummaryContent;
      model: string;
      promptVersion: string;
      inputTokens: number;
      outputTokens: number;
    },
  ): Promise<void> {
    const values = {
      content: summary.content as unknown as Record<string, unknown>,
      model: summary.model,
      promptVersion: summary.promptVersion,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      createdAt: sql`now()`,
    };
    await tx
      .insert(meetingSummaries)
      .values({ meetingId: meeting.id, orgId: meeting.orgId, ...values })
      .onConflictDoUpdate({ target: meetingSummaries.meetingId, set: values });
  }

  /**
   * Đưa meeting về `failed` (B5: sự kiện `failed` của BullMQ). Điều kiện `attempt` + chưa kết thúc:
   * sự kiện của lần chạy CŨ tới muộn không được đè lên lần chạy lại.
   */
  async fail(
    executor: DbExecutor,
    meetingId: string,
    attempt: number,
    code: MeetingFailureCode,
    message: string,
  ): Promise<{ orgId: string; ownerId: string | null; title: string } | undefined> {
    const [row] = await executor
      .update(meetings)
      .set({
        status: 'failed',
        failureCode: code,
        failureMessage: message,
        stageToken: null,
        stageLeaseUntil: null,
      })
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.attempt, attempt),
          isNull(meetings.deletedAt),
          notInArray(meetings.status, ['completed', 'failed']),
        ),
      )
      .returning({ orgId: meetings.orgId, ownerId: meetings.ownerId, title: meetings.title });
    return row;
  }
}
