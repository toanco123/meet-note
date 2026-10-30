import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, gt, lte, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  type OrgDailyStatsRow,
  orgDailyStats,
  organizations,
} from '../../../infra/database/schema/index.js';
import { REPORT_TIME_ZONE } from '../../reports/report-week.js';

/** Truy vấn của dashboard tổ chức (M17). Mọi hàm lọc `org_id` TƯỜNG MINH, không trông cậy vào RLS. */
@Injectable()
export class DashboardRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * TÍNH LẠI cả ngày `day` (giờ VN, 'YYYY-MM-DD') của một tổ chức từ `meetings` rồi ghi đè — MỘT câu
   * `INSERT … SELECT … ON CONFLICT DO UPDATE` (Q1). Không cộng dồn nên chạy lại cho cùng kết quả.
   *
   * - Aggregate KHÔNG có `GROUP BY` luôn trả đúng một dòng, kể cả khi không có meeting nào → ngày hết
   *   meeting (đã xoá / chuyển sang ngày khác) được ghi đè về 0, không để số cũ nằm lại.
   * - Biên ngày: `(day)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'` — đổi ngày LỊCH sang thời điểm,
   *   không phụ thuộc `TimeZone` của session; cộng 1 ngày trên ngày lịch rồi mới đổi múi giờ.
   * - Meeting xoá mềm không tính. `completed` / `failed` đếm riêng; đang xử lý chỉ nằm trong `total`.
   *
   * Hai lần gọi SONG SONG cùng (org, ngày) có thể để bản đọc cũ ghi đè bản mới: người gọi phải tuần
   * tự hoá (khoá advisory — `StatsRollupService`, B2). Hàm này không tự khoá.
   */
  async rollupDay(orgId: string, day: string, executor: DbExecutor = this.db): Promise<void> {
    const from = sql`(${day}::date)::timestamp at time zone ${REPORT_TIME_ZONE}`;
    const to = sql`((${day}::date + 1))::timestamp at time zone ${REPORT_TIME_ZONE}`;
    await executor.execute(sql`
      insert into org_daily_stats
        (org_id, day, meetings_total, meetings_completed, meetings_failed,
         recorded_ms, transcribed_ms, computed_at)
      select
        ${orgId}::uuid,
        ${day}::date,
        count(*),
        count(*) filter (where status = 'completed'),
        count(*) filter (where status = 'failed'),
        coalesce(sum(duration_ms), 0),
        coalesce(sum(duration_ms) filter (where status = 'completed'), 0),
        now()
      from meetings
      where org_id = ${orgId}::uuid
        and deleted_at is null
        and recorded_at >= ${from}
        and recorded_at < ${to}
      on conflict (org_id, day) do update set
        meetings_total = excluded.meetings_total,
        meetings_completed = excluded.meetings_completed,
        meetings_failed = excluded.meetings_failed,
        recorded_ms = excluded.recorded_ms,
        transcribed_ms = excluded.transcribed_ms,
        computed_at = excluded.computed_at
    `);
  }

  /** Các dòng rollup trong `[from, to]` (bao gồm hai đầu), ngày tăng dần. Ngày chưa tính thì không có dòng. */
  readRange(
    orgId: string,
    from: string,
    to: string,
    executor: DbExecutor = this.db,
  ): Promise<OrgDailyStatsRow[]> {
    return executor
      .select()
      .from(orgDailyStats)
      .where(
        and(
          eq(orgDailyStats.orgId, orgId),
          gte(orgDailyStats.day, from),
          lte(orgDailyStats.day, to),
        ),
      )
      .orderBy(asc(orgDailyStats.day));
  }

  /**
   * Các (tổ chức, ngày VN của `recorded_at`) có meeting đổi từ `since` (theo `updated_at`) — gồm cả
   * meeting đã xoá mềm. Dùng cho tick: chỉ tính lại ngày THẬT SỰ bị ảnh hưởng. `limit` chặn một đợt
   * thay đổi hàng loạt; phần dư để lần tick sau / job đêm. Không có index theo `updated_at` cho meeting
   * đã xong (thêm sẽ làm mất HOT update của bảng được sửa liên tục bởi pipeline) — quét tuần tự 5 phút
   * một lần là chấp nhận được ở quy mô này; đo lại nếu bảng `meetings` lớn lên.
   */
  async findChangedDays(
    since: Date,
    limit: number,
    executor: DbExecutor = this.db,
  ): Promise<Array<{ orgId: string; day: string }>> {
    const result = await executor.execute<{ org_id: string; day: string }>(sql`
      select distinct
        org_id,
        to_char((recorded_at at time zone ${REPORT_TIME_ZONE})::date, 'YYYY-MM-DD') as day
      from meetings
      where updated_at >= ${since.toISOString()}::timestamptz
      order by org_id, day
      limit ${limit}
    `);
    return result.rows.map((r) => ({ orgId: r.org_id, day: r.day }));
  }

  /** Id tổ chức theo thứ tự `id`, keyset — job đêm duyệt hết mọi tổ chức theo lô. */
  async listOrgIds(
    after: string | undefined,
    limit: number,
    executor: DbExecutor = this.db,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: organizations.id })
      .from(organizations)
      .where(after ? gt(organizations.id, after) : undefined)
      .orderBy(asc(organizations.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
