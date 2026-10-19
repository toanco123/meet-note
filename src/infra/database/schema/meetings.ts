import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { organizations } from './organizations.js';

export const MEETING_STATUSES = [
  'queued',
  'preprocessing',
  'transcribing',
  'summarizing',
  'completed',
  'failed',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

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
    failureCode: text(),
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
    check('meetings_status_ck', inValues(t.status, MEETING_STATUSES)),
    check('meetings_title_length_ck', sql`char_length(${t.title}) between 1 and 200`),
    check('meetings_attempt_ck', sql`${t.attempt} >= 1`),
    check('meetings_duration_ck', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
  ],
);

export type MeetingRow = typeof meetings.$inferSelect;
