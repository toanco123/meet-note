import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './channels.js';
import { inValues } from './column-types.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

export const MEETING_STATUSES = [
  'queued',
  'preprocessing',
  'transcribing',
  'summarizing',
  'completed',
  'failed',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/** Vì sao pipeline dừng ở `failed` (M6) — mã cho máy đọc; câu cho người đọc ở `failure_message`. */
export const MEETING_FAILURE_CODES = [
  'SOURCE_CHECKSUM_MISMATCH',
  'MEDIA_UNREADABLE',
  'MEDIA_NO_AUDIO',
  'MEDIA_TOO_LONG',
  'TRANSCRIBE_FAILED',
  'SUMMARIZE_FAILED',
] as const;
export type MeetingFailureCode = (typeof MEETING_FAILURE_CODES)[number];

/**
 * Cuộc họp. M5 tạo ở `queued` khi upload xong; M6 chuyển trạng thái bằng UPDATE có điều kiện.
 *
 * KHOÁ NGOẠI `(org_id, owner_id) → organization_members` KHÔNG khai báo ở đây: cần
 * `ON DELETE SET NULL (owner_id)` (PostgreSQL 15+, chỉ null MỘT cột), Drizzle chỉ sinh được
 * `SET NULL` cho cả hai cột → `org_id NOT NULL` vỡ (23502) và việc xoá thành viên khỏi org thất bại.
 * Ràng buộc nằm ở migration viết tay `0007_meetings_owner_fk.sql` (M5 Q1).
 */
export const meetings = pgTable(
  'meetings',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    /** NULL = chủ đã rời tổ chức; meeting ở lại tổ chức (M5 Q1). */
    ownerId: uuid(),
    title: text().notNull(),
    /** Thời điểm họp (do người dùng khai), dùng cho báo cáo tuần. */
    recordedAt: timestamp({ withTimezone: true }).notNull(),
    /** Điền sau khi ffprobe (M6). */
    durationMs: integer(),
    /** Whisper phát hiện (M6). */
    language: text(),
    status: text({ enum: MEETING_STATUSES }).notNull().default('queued'),
    failureCode: text({ enum: MEETING_FAILURE_CODES }),
    failureMessage: text(),
    /** Lần chạy pipeline — nằm trong jobId `meeting.preprocess.{id}.a{attempt}`. */
    attempt: integer().notNull().default(1),
    sourceObjectKey: text().notNull(),
    /** Audio đã chuẩn hoá (M6). */
    audioObjectKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'meetings_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    // Đích cho composite FK của bảng con (uploads, meeting_shares ở M6).
    unique('meetings_id_org_uq').on(t.id, t.orgId),
    // Hai việc một index: (1) "meeting của tôi" mới nhất trước (M6) — DESC NULLS FIRST khớp
    // ORDER BY … DESC (bài học M3); (2) khoá ngoại `meetings_owner_fk`: xoá một thành viên org thì
    // Postgres phải tìm MỌI meeting (kể cả đã xoá mềm) của người đó — Postgres KHÔNG tự tạo index
    // cho phía tham chiếu. Vì vậy KHÔNG để partial `WHERE deleted_at IS NULL` (sẽ không dùng được
    // cho lần tìm đó → quét cả bảng mỗi lần gỡ thành viên).
    index('meetings_org_owner_created_idx').on(
      t.orgId,
      t.ownerId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('meetings_org_recorded_idx').on(t.orgId, t.recordedAt),
    // Danh sách meeting (M11 B5) gộp các luồng keyset `(recorded_at DESC, id DESC)` có trần:
    // "của mình" và "không chủ" (Owner / Admin org). `DESC NULLS FIRST` khớp `ORDER BY … DESC`.
    index('meetings_org_owner_recorded_idx')
      .on(t.orgId, t.ownerId, t.recordedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.deletedAt} is null`),
    index('meetings_org_ownerless_recorded_idx')
      .on(t.orgId, t.recordedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.ownerId} is null and ${t.deletedAt} is null`),
    check('meetings_status_ck', inValues(t.status, MEETING_STATUSES)),
    check('meetings_title_length_ck', sql`char_length(${t.title}) between 1 and 200`),
    check('meetings_attempt_ck', sql`${t.attempt} >= 1`),
    check(
      'meetings_failure_code_ck',
      sql`${t.failureCode} is null or ${inValues(t.failureCode, MEETING_FAILURE_CODES)}`,
    ),
    // Quét meeting kẹt (M6): chưa xong mà lâu không đổi → enqueue lại bước đúng trạng thái.
    index('meetings_stuck_idx')
      .on(t.updatedAt)
      .where(
        sql`${t.status} in ('queued', 'preprocessing', 'transcribing', 'summarizing') and ${t.deletedAt} is null`,
      ),
    check('meetings_duration_ck', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
  ],
);

export type MeetingRow = typeof meetings.$inferSelect;

/**
 * Meeting được chia sẻ vào kênh (D3: một meeting, 0..n kênh) — M6b.
 *
 * Hai composite FK theo `org_id` → DB tự chặn share chéo tổ chức dù code có bug. Cả hai CASCADE:
 * xoá cứng meeting / purge kênh (D3: "chỉ gỡ share, không xoá meeting") tự dọn share.
 */
export const meetingShares = pgTable(
  'meeting_shares',
  {
    meetingId: uuid().notNull(),
    channelId: uuid().notNull(),
    orgId: uuid().notNull(),
    /** Người share. NULL nếu tài khoản bị xoá — share vẫn giữ (meeting vẫn thuộc kênh). */
    sharedBy: uuid(),
    /**
     * BẢN CHÉP `meetings.recorded_at` (phi chuẩn hoá có chủ đích, M11 B5): danh sách meeting đi theo
     * từng kênh thấy được với keyset `(recorded_at, meeting_id)` trên index của bảng này — không phải
     * quét mọi share. Ghi khi share, cập nhật trong CÙNG transaction khi sửa `recordedAt` của meeting.
     */
    recordedAt: timestamp({ withTimezone: true }).notNull(),
    sharedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'meeting_shares_pk', columns: [t.meetingId, t.channelId] }),
    foreignKey({
      name: 'meeting_shares_meeting_fk',
      columns: [t.meetingId, t.orgId],
      foreignColumns: [meetings.id, meetings.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_shares_channel_fk',
      columns: [t.channelId, t.orgId],
      foreignColumns: [channels.id, channels.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'meeting_shares_shared_by_fk',
      columns: [t.sharedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    // `GET /channels/:id/meetings` (keyset shared_at DESC, meeting_id DESC); cũng là index phía
    // tham chiếu cho FK kênh (purge kênh tìm share theo channel_id). Phía meeting: PK đã bắt đầu
    // bằng meeting_id.
    index('meeting_shares_channel_shared_idx').on(
      t.channelId,
      t.sharedAt.desc(),
      t.meetingId.desc(),
    ),
    // Luồng "meeting qua từng kênh thấy được" của danh sách meeting (M11 B5).
    index('meeting_shares_channel_recorded_idx').on(
      t.channelId,
      t.recordedAt.desc().nullsFirst(),
      t.meetingId.desc().nullsFirst(),
    ),
  ],
);

export type MeetingShareRow = typeof meetingShares.$inferSelect;
