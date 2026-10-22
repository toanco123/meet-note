import { type SQL, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { meetings } from './meetings.js';

/** Drizzle 0.45 chưa có `tsvector` dựng sẵn — chỉ dùng cho cột generated, không ghi từ app. */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Đoạn transcript của một meeting (M6). Ghi = XOÁ rồi CHÈN lại trong một transaction → chạy lại
 * bước transcribe vẫn ra đúng một bộ đoạn (idempotent, 03 §4).
 *
 * Mang `org_id` + composite FK + RLS (M6 Q8): M8 tìm full-text quét THẲNG bảng này theo từ khoá —
 * đúng chỗ một query quên lọc tổ chức sẽ lộ nội dung họp; RLS chặn ở DB.
 */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    // bigint identity như audit_logs: bảng nhiều dòng (hàng nghìn đoạn / meeting), không lộ ra ngoài.
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid().notNull(),
    orgId: uuid().notNull(),
    /** Thứ tự trong meeting, bắt đầu từ 0 — cursor của `GET …/transcript`. */
    seq: integer().notNull(),
    startMs: integer().notNull(),
    endMs: integer().notNull(),
    /** Để dành cho phân biệt người nói (ngoài phạm vi M6). */
    speaker: text(),
    text: text().notNull(),
    // BẪY (03 §4): config phải là HẰNG `'meetnote_vi'::regconfig` — `to_tsvector(regconfig, text)`
    // với hằng là IMMUTABLE; bản một tham số phụ thuộc `default_text_search_config` → không dùng
    // được trong generated column.
    search: tsvector().generatedAlwaysAs(
      (): SQL => sql`to_tsvector('meetnote_vi'::regconfig, ${transcriptSegments.text})`,
    ),
  },
  (t) => [
    // Cũng là index phía tham chiếu cho FK (meeting_id đứng đầu): xoá meeting → cascade tìm nhanh.
    unique('transcript_segments_meeting_seq_uq').on(t.meetingId, t.seq),
    foreignKey({
      name: 'transcript_segments_meeting_fk',
      columns: [t.meetingId, t.orgId],
      foreignColumns: [meetings.id, meetings.orgId],
    }).onDelete('cascade'),
    check('transcript_segments_seq_ck', sql`${t.seq} >= 0`),
    check('transcript_segments_time_ck', sql`${t.startMs} >= 0 and ${t.endMs} >= ${t.startMs}`),
    index('transcript_segments_search_idx').using('gin', t.search),
  ],
);

/** Tóm tắt AI của một meeting (M6) — một dòng / meeting, ghi bằng upsert. */
export const meetingSummaries = pgTable(
  'meeting_summaries',
  {
    meetingId: uuid().primaryKey(),
    orgId: uuid().notNull(),
    /** `{ overview, keyPoints[], decisions[], actionItems[{ owner, task, due }] }` — module validate. */
    content: jsonb().notNull().$type<Record<string, unknown>>(),
    model: text().notNull(),
    /** Đổi prompt → đổi phiên bản: biết tóm tắt nào sinh bằng prompt nào. */
    promptVersion: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'meeting_summaries_meeting_fk',
      columns: [t.meetingId, t.orgId],
      foreignColumns: [meetings.id, meetings.orgId],
    }).onDelete('cascade'),
    check('meeting_summaries_tokens_ck', sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`),
  ],
);

export type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
export type MeetingSummaryRow = typeof meetingSummaries.$inferSelect;
