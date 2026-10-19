import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { meetings } from './meetings.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

export const UPLOAD_STATUSES = ['initiated', 'completed', 'aborted', 'expired'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** `mimeType` client khai lúc init. Định dạng THẬT do ffprobe kiểm ở M6. */
export const UPLOAD_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/webm',
] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

/** 2 GiB (D4). */
export const UPLOAD_MAX_BYTES = 2 * 1024 ** 3;
/** S3 multipart: mỗi phần (trừ phần cuối) ≥ 5 MiB; tối đa 10 000 phần. */
export const S3_MIN_PART_BYTES = 5 * 1024 ** 2;
export const S3_MAX_PARTS = 10_000;

/**
 * Một phiên upload chunked, map 1–1 vào một S3 multipart upload (`s3_upload_id`).
 * `title` / `recorded_at` khai lúc init để `complete` tạo được meeting.
 */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    /**
     * Trỏ `users`, KHÔNG trỏ thành viên org (M5 Q1): người tạo rời org thì cascade không xoá dòng
     * này trong khi S3 vẫn giữ các phần — job dọn dẹp sẽ abort khi upload hết hạn.
     */
    userId: uuid().notNull(),
    filename: text().notNull(),
    mimeType: text({ enum: UPLOAD_MIME_TYPES }).notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    /** sha256 toàn file, hex thường — client gửi lúc init, worker kiểm lại ở M6. */
    sha256: text().notNull(),
    chunkSize: integer().notNull(),
    totalParts: integer().notNull(),
    title: text().notNull(),
    recordedAt: timestamp({ withTimezone: true }).notNull(),
    /** `orgs/{orgId}/uploads/{uploadId}/source` — không chứa dữ liệu người dùng. */
    objectKey: text().notNull(),
    s3UploadId: text().notNull(),
    status: text({ enum: UPLOAD_STATUSES }).notNull().default('initiated'),
    meetingId: uuid(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * Đã gọi `AbortMultipartUpload` thành công. Huỷ / hết hạn: đánh dấu status TRƯỚC (trong DB),
     * gọi S3 SAU (ngoài transaction); S3 lỗi → cột này còn NULL → lần dọn sau thử lại.
     */
    storageAbortedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'uploads_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'uploads_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }),
    // Meeting tạo ra phải cùng org với upload.
    foreignKey({
      name: 'uploads_meeting_fk',
      columns: [t.meetingId, t.orgId],
      foreignColumns: [meetings.id, meetings.orgId],
    }),
    // Job dọn upload hết hạn (B7): chỉ upload còn mở.
    index('uploads_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'initiated'`),
    // Thử abort lại trên S3 những upload đã huỷ / hết hạn mà lần trước gọi S3 lỗi.
    index('uploads_abort_retry_idx')
      .on(t.id)
      .where(sql`${t.status} in ('aborted', 'expired') and ${t.storageAbortedAt} is null`),
    check('uploads_status_ck', inValues(t.status, UPLOAD_STATUSES)),
    check('uploads_mime_type_ck', inValues(t.mimeType, UPLOAD_MIME_TYPES)),
    check(
      'uploads_size_ck',
      sql`${t.sizeBytes} between 1 and ${sql.raw(String(UPLOAD_MAX_BYTES))}`,
    ),
    check('uploads_sha256_ck', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('uploads_chunk_size_ck', sql`${t.chunkSize} >= ${sql.raw(String(S3_MIN_PART_BYTES))}`),
    // total_parts = ceil(size / chunk) — DB chặn số liệu lệch nhau dù code có bug.
    check(
      'uploads_total_parts_ck',
      sql`${t.totalParts} = (${t.sizeBytes} + ${t.chunkSize} - 1) / ${t.chunkSize} and ${t.totalParts} <= ${sql.raw(String(S3_MAX_PARTS))}`,
    ),
    check('uploads_filename_length_ck', sql`char_length(${t.filename}) between 1 and 255`),
    check('uploads_title_length_ck', sql`char_length(${t.title}) between 1 and 200`),
    // `completed` ⇔ đã có meeting và thời điểm hoàn tất.
    check(
      'uploads_completed_ck',
      sql`(${t.status} = 'completed') = (${t.meetingId} is not null and ${t.completedAt} is not null)`,
    ),
  ],
);

/**
 * Phần đã nhận. PUT cùng phần lần nữa = `ON CONFLICT DO UPDATE` (idempotent).
 * Không mang `org_id`: chỉ có MỘT bảng cha (`uploads`), không có đường nào ghép chéo tổ chức —
 * composite FK theo org chỉ cần khi một dòng tham chiếu từ HAI phía (như `channel_members`).
 */
export const uploadParts = pgTable(
  'upload_parts',
  {
    uploadId: uuid().notNull(),
    partNumber: integer().notNull(),
    sizeBytes: integer().notNull(),
    etag: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'upload_parts_pk', columns: [t.uploadId, t.partNumber] }),
    foreignKey({
      name: 'upload_parts_upload_fk',
      columns: [t.uploadId],
      foreignColumns: [uploads.id],
    }).onDelete('cascade'),
    check(
      'upload_parts_number_ck',
      sql`${t.partNumber} between 1 and ${sql.raw(String(S3_MAX_PARTS))}`,
    ),
    check('upload_parts_size_ck', sql`${t.sizeBytes} > 0`),
  ],
);

export type UploadRow = typeof uploads.$inferSelect;
export type UploadPartRow = typeof uploadParts.$inferSelect;
