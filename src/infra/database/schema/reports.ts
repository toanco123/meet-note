import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './channels.js';
import { inValues } from './column-types.js';
import { users } from './users.js';

export const REPORT_STATUSES = ['pending', 'generating', 'completed', 'failed', 'skipped'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_TRIGGERS = ['scheduled', 'manual'] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];

/** Số lần tạo lại thủ công tối đa mỗi báo cáo (D8). DB là chốt chặn cuối của quota. */
export const MAX_REGENERATE_COUNT = 3;

/**
 * Báo cáo tuần của một kênh (M9, 03 §5). `UNIQUE (channel_id, week_start)` là KHOÁ IDEMPOTENCY của
 * cron: tick chạy hai lần chỉ tạo một dòng (`ON CONFLICT DO NOTHING`).
 *
 * `status` là chặng hiện tại, `generation_token` + `lease_until` là lease/fencing token như
 * `meetings` (M6 B4): retry của BullMQ phải nhận lại được việc đang `generating` mà worker trước
 * đã bỏ — `UPDATE … WHERE status = 'pending'` thì kẹt mãi.
 */
export const weeklyReports = pgTable(
  'weekly_reports',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    channelId: uuid().notNull(),
    orgId: uuid().notNull(),
    /** Thứ Hai của tuần theo giờ VN, dạng 'YYYY-MM-DD' (KHÔNG qua `Date` — tránh lệch múi giờ). */
    weekStart: date({ mode: 'string' }).notNull(),
    status: text({ enum: REPORT_STATUSES }).notNull().default('pending'),
    regenerateCount: smallint().notNull().default(0),
    /** Phiên bản đang hiển thị. Tạo lại LỖI không đổi cột này → người xem vẫn thấy bản cũ. */
    currentVersion: integer(),
    lastError: text(),
    generationToken: uuid(),
    leaseUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('weekly_reports_channel_week_uq').on(t.channelId, t.weekStart),
    // Đích của composite FK từ `weekly_report_versions`.
    unique('weekly_reports_id_org_uq').on(t.id, t.orgId),
    foreignKey({
      name: 'weekly_reports_channel_fk',
      columns: [t.channelId, t.orgId],
      foreignColumns: [channels.id, channels.orgId],
    }).onDelete('cascade'),
    check('weekly_reports_status_ck', inValues(t.status, REPORT_STATUSES)),
    check(
      'weekly_reports_regenerate_ck',
      sql`${t.regenerateCount} between 0 and ${sql.raw(String(MAX_REGENERATE_COUNT))}`,
    ),
    check(
      'weekly_reports_version_ck',
      sql`${t.currentVersion} is null or ${t.currentVersion} >= 1`,
    ),
    // Đã `completed` thì phải có bản để hiển thị.
    check(
      'weekly_reports_completed_ck',
      sql`${t.status} <> 'completed' or ${t.currentVersion} is not null`,
    ),
    // Tuần luôn bắt đầu Thứ Hai (isodow = 1): một ngày khác là lỗi tính tuần ở đâu đó.
    check('weekly_reports_monday_ck', sql`extract(isodow from ${t.weekStart}) = 1`),
    // Tick / quét: báo cáo của một tuần theo trạng thái.
    index('weekly_reports_week_status_idx').on(t.weekStart, t.status),
    // Quét kẹt: chỉ các dòng chưa xong, cũ nhất trước.
    index('weekly_reports_stuck_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} in ('pending', 'generating')`),
  ],
);

/**
 * Một phiên bản nội dung của báo cáo (M9). Chỉ THÊM, không sửa: tạo lại sinh version mới, bản cũ còn
 * xem được. `meeting_ids` chụp danh sách meeting lúc sinh — báo cáo cũ không đổi khi meeting bị gỡ
 * share sau đó.
 */
export const weeklyReportVersions = pgTable(
  'weekly_report_versions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    reportId: uuid().notNull(),
    orgId: uuid().notNull(),
    version: integer().notNull(),
    trigger: text({ enum: REPORT_TRIGGERS }).notNull(),
    /** Người bấm "tạo lại"; NULL với bản theo lịch hoặc khi người đó đã rời hệ thống. */
    triggeredBy: uuid(),
    /** `{ overview, highlights[], decisions[], actionItems[], meetings[{id,title}] }` — module validate. */
    content: jsonb().notNull().$type<Record<string, unknown>>(),
    meetingIds: uuid().array().notNull(),
    /** Đã cắt bớt meeting khi đưa vào prompt (quá giới hạn). */
    truncated: boolean().notNull().default(false),
    model: text().notNull(),
    promptVersion: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('weekly_report_versions_report_version_uq').on(t.reportId, t.version),
    foreignKey({
      name: 'weekly_report_versions_report_fk',
      columns: [t.reportId, t.orgId],
      foreignColumns: [weeklyReports.id, weeklyReports.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'weekly_report_versions_triggered_by_fk',
      columns: [t.triggeredBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check('weekly_report_versions_version_ck', sql`${t.version} >= 1`),
    check('weekly_report_versions_trigger_ck', inValues(t.trigger, REPORT_TRIGGERS)),
    check(
      'weekly_report_versions_tokens_ck',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`,
    ),
    // Index phía tham chiếu của `triggered_by` (xoá user → SET NULL tìm nhanh).
    index('weekly_report_versions_triggered_by_idx')
      .on(t.triggeredBy)
      .where(sql`${t.triggeredBy} is not null`),
  ],
);

export type WeeklyReportRow = typeof weeklyReports.$inferSelect;
export type WeeklyReportVersionRow = typeof weeklyReportVersions.$inferSelect;
