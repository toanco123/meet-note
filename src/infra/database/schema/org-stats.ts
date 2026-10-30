import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

/**
 * Rollup theo ngày của tổ chức (M17): MỘT dòng cho mỗi (org, ngày giờ VN), chỉ chứa số CỘNG ĐƯỢC.
 * Số không cộng được (người hoạt động phân biệt, dung lượng hiện tại…) tính trực tiếp khi gọi API —
 * "người phân biệt của 7 ngày" khác tổng 7 con số hằng ngày.
 *
 * Không có bộ đếm tăng dần: worker TÍNH LẠI cả ngày từ `meetings` rồi ghi đè (`INSERT … SELECT …
 * ON CONFLICT DO UPDATE`), nên chạy lại bao nhiêu lần cũng cho đúng một kết quả — idempotent theo
 * thiết kế, không cần nhớ "đã đếm meeting này chưa". Ngày không còn meeting nào thì dòng về 0.
 *
 * Ngày = ngày lịch giờ VN của `meetings.recorded_at` (cùng quy ước báo cáo tuần, M9). Meeting đã xoá
 * mềm không tính. RLS theo `org_id` viết tay trong migration `0019` (cùng mẫu `action_items`).
 */
export const orgDailyStats = pgTable(
  'org_daily_stats',
  {
    orgId: uuid().notNull(),
    /** Ngày lịch giờ VN, 'YYYY-MM-DD'. */
    day: date({ mode: 'string' }).notNull(),
    meetingsTotal: integer().notNull().default(0),
    meetingsCompleted: integer().notNull().default(0),
    meetingsFailed: integer().notNull().default(0),
    /** Tổng thời lượng mọi meeting đã biết `duration_ms` (ms). */
    recordedMs: bigint({ mode: 'number' }).notNull().default(0),
    /** Tổng thời lượng meeting đã `completed` (ms) = phần đã transcribe + tóm tắt xong. */
    transcribedMs: bigint({ mode: 'number' }).notNull().default(0),
    /** Lần tính lại gần nhất — API trả ra để người xem biết số trễ bao nhiêu. */
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'org_daily_stats_pk', columns: [t.orgId, t.day] }),
    foreignKey({
      name: 'org_daily_stats_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    check(
      'org_daily_stats_counts_ck',
      sql`${t.meetingsTotal} >= 0 and ${t.meetingsCompleted} >= 0 and ${t.meetingsFailed} >= 0
        and ${t.meetingsCompleted} + ${t.meetingsFailed} <= ${t.meetingsTotal}`,
    ),
    check(
      'org_daily_stats_ms_ck',
      sql`${t.recordedMs} >= 0 and ${t.transcribedMs} >= 0 and ${t.transcribedMs} <= ${t.recordedMs}`,
    ),
  ],
);

export type OrgDailyStatsRow = typeof orgDailyStats.$inferSelect;
