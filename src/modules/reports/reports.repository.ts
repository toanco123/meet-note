import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  channels,
  meetings,
  meetingShares,
  meetingSummaries,
  type WeeklyReportRow,
  type WeeklyReportVersionRow,
  weeklyReports,
  weeklyReportVersions,
} from '../../infra/database/schema/index.js';
import type { MeetingSummaryContent } from '../../infra/llm/llm.types.js';
import { REPORT_TIME_ZONE } from './report-week.js';
import type { ClaimedReport, NewReportVersion, ReportMeeting } from './reports.types.js';

/**
 * Truy vấn của báo cáo tuần (M9). Worker (user BYPASSRLS) và api (bị RLS, ngữ cảnh tổ chức do
 * `OrgMemberGuard`) cùng dùng — nên mọi truy vấn lọc `org_id` TƯỜNG MINH, không trông cậy vào RLS.
 */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Meeting của báo cáo tuần `weekStart` (Thứ Hai, giờ VN) của một kênh (D8, plan M9 Q2): `completed`,
   * chưa xoá, ĐANG được share vào kênh, `recorded_at` thuộc `[weekStart 00:00, +7 ngày)` GIỜ VN. Cũ
   * nhất trước (tóm tắt đọc theo thứ tự thời gian).
   *
   * Biên tuần tính bằng `(ngày)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`: phép chuyển ngày lịch
   * → thời điểm, KHÔNG phụ thuộc `TimeZone` của session; cũng không dùng `date_trunc('week', now())`.
   * Cộng 7 ngày trên ngày LỊCH rồi mới đổi múi giờ, không cộng `interval '7 days'` lên thời điểm.
   *
   * Lọc thời gian trên bản chép `meeting_shares.recorded_at` (M11 B5, luôn cập nhật cùng transaction
   * với meeting) để dùng index `(channel_id, recorded_at …)` thay vì quét mọi meeting của org.
   */
  async meetingsForWeek(
    orgId: string,
    channelId: string,
    weekStart: string,
  ): Promise<ReportMeeting[]> {
    const from = sql`(${weekStart}::date)::timestamp at time zone ${REPORT_TIME_ZONE}`;
    const to = sql`((${weekStart}::date + 7))::timestamp at time zone ${REPORT_TIME_ZONE}`;
    const rows = await this.db
      .select({
        id: meetings.id,
        title: meetings.title,
        recordedAt: meetings.recordedAt,
        summary: meetingSummaries.content,
      })
      .from(meetingShares)
      .innerJoin(meetings, eq(meetings.id, meetingShares.meetingId))
      // Meeting `completed` luôn có tóm tắt (M6); inner join để meeting thiếu tóm tắt (bất thường)
      // không vào báo cáo thay vì làm lỗi cả báo cáo.
      .innerJoin(meetingSummaries, eq(meetingSummaries.meetingId, meetings.id))
      .where(
        and(
          eq(meetingShares.orgId, orgId),
          eq(meetingShares.channelId, channelId),
          eq(meetings.status, 'completed'),
          isNull(meetings.deletedAt),
          gte(meetingShares.recordedAt, sql`${from}`),
          lt(meetingShares.recordedAt, sql`${to}`),
        ),
      )
      .orderBy(asc(meetingShares.recordedAt), asc(meetings.id));
    return rows.map((r) => ({ ...r, summary: r.summary as unknown as MeetingSummaryContent }));
  }

  /**
   * Nhận việc tạo báo cáo bằng MỘT câu UPDATE có điều kiện (lease + fencing token, như `claim` của
   * meeting — M6 B4): đúng `generation`, đang chờ (`pending`) hoặc đang tạo mà lease TRỐNG / HẾT HẠN
   * (retry sau lỗi tạm đã nhả lease; worker chết thì lease tự hết). `completed` / `skipped` / `failed`
   * không nhận lại → job trùng là no-op. 0 dòng = job cũ, trùng, đang có người giữ, hay kênh đã xoá.
   */
  async claim(
    reportId: string,
    generation: number,
    leaseMs: number,
  ): Promise<ClaimedReport | undefined> {
    const [row] = await this.db
      .update(weeklyReports)
      .set({
        status: 'generating',
        generationToken: sql`gen_random_uuid()`,
        leaseUntil: sql`now() + ${leaseMs} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(weeklyReports.id, reportId),
          eq(weeklyReports.regenerateCount, generation),
          inArray(weeklyReports.status, ['pending', 'generating']),
          or(isNull(weeklyReports.leaseUntil), sql`${weeklyReports.leaseUntil} < now()`),
        ),
      )
      .returning({
        id: weeklyReports.id,
        orgId: weeklyReports.orgId,
        channelId: weeklyReports.channelId,
        weekStart: weeklyReports.weekStart,
        generation: weeklyReports.regenerateCount,
        requestedTrigger: weeklyReports.requestedTrigger,
        requestedBy: weeklyReports.requestedBy,
        generationToken: weeklyReports.generationToken,
      });
    if (!row) return undefined;
    const [channel] = await this.db
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, row.channelId));
    return {
      ...row,
      channelName: channel?.name ?? '',
      generationToken: row.generationToken as string,
    };
  }

  /** Lỗi → nhả lease NGAY để retry nhận lại, không phải chờ hết hạn. Chỉ nhả lease CỦA MÌNH. */
  async release(reportId: string, token: string): Promise<void> {
    await this.db
      .update(weeklyReports)
      .set({ generationToken: null, leaseUntil: null })
      .where(and(eq(weeklyReports.id, reportId), eq(weeklyReports.generationToken, token)));
  }

  /** Dưới 2 meeting: `skipped`. Có kiểm token — `false` = đã mất lease (worker khác nhận). */
  async completeSkipped(tx: DbExecutor, reportId: string, token: string): Promise<boolean> {
    const rows = await tx
      .update(weeklyReports)
      .set({ status: 'skipped', lastError: null, generationToken: null, leaseUntil: null })
      .where(and(eq(weeklyReports.id, reportId), eq(weeklyReports.generationToken, token)))
      .returning({ id: weeklyReports.id });
    return rows.length > 0;
  }

  /**
   * Ghi phiên bản mới + đổi `current_version`, CHỈ khi token còn là của mình (fencing) — lease hết hạn
   * và worker khác đã nhận thì 0 dòng → KHÔNG ghi. Chuyển trạng thái TRƯỚC (đây là phép kiểm token),
   * rồi mới chèn version; cùng một transaction nên hoặc cả hai hoặc không gì.
   */
  async completeGenerated(
    tx: DbExecutor,
    report: Pick<ClaimedReport, 'id' | 'orgId'>,
    token: string,
    version: NewReportVersion,
  ): Promise<number | undefined> {
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${weeklyReportVersions.version}), 0) + 1` })
      .from(weeklyReportVersions)
      .where(eq(weeklyReportVersions.reportId, report.id));
    const rows = await tx
      .update(weeklyReports)
      .set({
        status: 'completed',
        currentVersion: next,
        lastError: null,
        generationToken: null,
        leaseUntil: null,
      })
      .where(and(eq(weeklyReports.id, report.id), eq(weeklyReports.generationToken, token)))
      .returning({ id: weeklyReports.id });
    if (rows.length === 0) return undefined;
    await tx.insert(weeklyReportVersions).values({
      reportId: report.id,
      orgId: report.orgId,
      version: next,
      ...version,
    });
    return next;
  }

  /**
   * Hết lượt / lỗi vĩnh viễn → `failed`. Điều kiện `generation` + còn đang chờ / tạo: sự kiện `failed`
   * của lần tạo CŨ tới muộn không đè lên lần tạo lại. KHÔNG đụng `current_version` — người xem vẫn
   * thấy bản cũ. `failed` không tính vào quota (03 §5).
   */
  async fail(reportId: string, generation: number, message: string): Promise<boolean> {
    const rows = await this.db
      .update(weeklyReports)
      .set({ status: 'failed', lastError: message, generationToken: null, leaseUntil: null })
      .where(
        and(
          eq(weeklyReports.id, reportId),
          eq(weeklyReports.regenerateCount, generation),
          inArray(weeklyReports.status, ['pending', 'generating']),
        ),
      )
      .returning({ id: weeklyReports.id });
    return rows.length > 0;
  }

  /**
   * Tạo dòng báo cáo `pending` cho MỘT lô kênh của tuần `weekStart` (kênh bật báo cáo, chưa xoá, chưa
   * lưu trữ — lưu trữ = chỉ đọc), keyset theo `channels.id`. `ON CONFLICT (channel_id, week_start) DO
   * NOTHING` là khoá idempotency: tick chạy hai lần / hai worker cùng chạy chỉ tạo một dòng mỗi kênh.
   * Một câu SQL nên lô nguyên tử; `lastChannelId` để gọi lô kế tiếp (`null` = hết kênh).
   */
  async insertWeekRows(
    weekStart: string,
    afterChannelId: string | null,
    limit: number,
  ): Promise<{ scanned: number; inserted: number; lastChannelId: string | null }> {
    const result = await this.db.execute<{
      scanned: number;
      inserted: number;
      last_id: string | null;
    }>(sql`
      with batch as (
        select id, org_id from ${channels}
        where ${channels.weeklyReportEnabled}
          and ${channels.deletedAt} is null
          and ${channels.archivedAt} is null
          and (${afterChannelId}::uuid is null or ${channels.id} > ${afterChannelId}::uuid)
        order by ${channels.id}
        limit ${limit}
      ), ins as (
        insert into ${weeklyReports} (channel_id, org_id, week_start)
        select id, org_id, ${weekStart}::date from batch
        on conflict (channel_id, week_start) do nothing
        returning 1
      )
      select (select count(*) from batch)::int as scanned,
             (select count(*) from ins)::int as inserted,
             (select id from batch order by id desc limit 1) as last_id`);
    const row = result.rows[0];
    return {
      scanned: row?.scanned ?? 0,
      inserted: row?.inserted ?? 0,
      lastChannelId: row?.last_id ?? null,
    };
  }

  /**
   * Mọi báo cáo `pending` của tuần, theo lô keyset `id` — tick enqueue job cho TẤT CẢ chứ không chỉ
   * dòng vừa chèn: tick trước có thể đã chèn rồi chết trước khi enqueue (bài học M6 B8).
   */
  pendingOfWeek(weekStart: string, afterId: string | null, limit: number) {
    return this.db
      .select({ id: weeklyReports.id, generation: weeklyReports.regenerateCount })
      .from(weeklyReports)
      .where(
        and(
          eq(weeklyReports.weekStart, weekStart),
          eq(weeklyReports.status, 'pending'),
          afterId ? sql`${weeklyReports.id} > ${afterId}::uuid` : undefined,
        ),
      )
      .orderBy(asc(weeklyReports.id))
      .limit(limit);
  }

  /** Danh sách báo cáo của kênh, tuần mới nhất trước; keyset `week_start` (duy nhất trong kênh). */
  listByChannel(
    orgId: string,
    channelId: string,
    beforeWeek: string | undefined,
    limit: number,
  ): Promise<WeeklyReportRow[]> {
    return this.db
      .select()
      .from(weeklyReports)
      .where(
        and(
          eq(weeklyReports.orgId, orgId),
          eq(weeklyReports.channelId, channelId),
          beforeWeek ? lt(weeklyReports.weekStart, beforeWeek) : undefined,
        ),
      )
      .orderBy(desc(weeklyReports.weekStart))
      .limit(limit + 1);
  }

  async findByWeek(
    orgId: string,
    channelId: string,
    weekStart: string,
  ): Promise<WeeklyReportRow | undefined> {
    const [row] = await this.db
      .select()
      .from(weeklyReports)
      .where(
        and(
          eq(weeklyReports.orgId, orgId),
          eq(weeklyReports.channelId, channelId),
          eq(weeklyReports.weekStart, weekStart),
        ),
      );
    return row;
  }

  /** Mọi phiên bản của một báo cáo, mới nhất trước (tối đa 1 + 3 lần tạo lại = 4). */
  versionsOf(orgId: string, reportId: string): Promise<WeeklyReportVersionRow[]> {
    return this.db
      .select()
      .from(weeklyReportVersions)
      .where(
        and(eq(weeklyReportVersions.orgId, orgId), eq(weeklyReportVersions.reportId, reportId)),
      )
      .orderBy(desc(weeklyReportVersions.version));
  }

  async findVersion(
    orgId: string,
    reportId: string,
    version: number,
  ): Promise<WeeklyReportVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(weeklyReportVersions)
      .where(
        and(
          eq(weeklyReportVersions.orgId, orgId),
          eq(weeklyReportVersions.reportId, reportId),
          eq(weeklyReportVersions.version, version),
        ),
      );
    return row;
  }

  /** Khoá dòng báo cáo `FOR UPDATE` — bước đầu của "tạo lại" (quota đọc-rồi-ghi phải nguyên tử). */
  async lockByWeek(
    tx: DbExecutor,
    orgId: string,
    channelId: string,
    weekStart: string,
  ): Promise<WeeklyReportRow | undefined> {
    const [row] = await tx
      .select()
      .from(weeklyReports)
      .where(
        and(
          eq(weeklyReports.orgId, orgId),
          eq(weeklyReports.channelId, channelId),
          eq(weeklyReports.weekStart, weekStart),
        ),
      )
      .for('update');
    return row;
  }

  /**
   * Ghi yêu cầu tạo lại trên dòng ĐÃ KHOÁ: quota +1, về `pending`, ghi ai bấm. `current_version` giữ
   * nguyên — người xem vẫn thấy bản cũ cho tới khi bản mới xong (Q5). Xoá lease cũ (nếu còn sót).
   */
  async markRegenerating(
    tx: DbExecutor,
    reportId: string,
    userId: string,
  ): Promise<WeeklyReportRow> {
    const [row] = await tx
      .update(weeklyReports)
      .set({
        status: 'pending',
        regenerateCount: sql`${weeklyReports.regenerateCount} + 1`,
        requestedTrigger: 'manual',
        requestedBy: userId,
        lastError: null,
        generationToken: null,
        leaseUntil: null,
      })
      .where(eq(weeklyReports.id, reportId))
      .returning();
    if (!row) throw new Error('markRegenerating: dòng đã khoá mà không cập nhật được');
    return row;
  }
}
