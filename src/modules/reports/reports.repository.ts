import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { meetings, meetingShares, meetingSummaries } from '../../infra/database/schema/index.js';
import type { MeetingSummaryContent } from '../../infra/llm/llm.types.js';
import { REPORT_TIME_ZONE } from './report-week.js';
import type { ReportMeeting } from './reports.types.js';

/** Truy vấn của báo cáo tuần (M9) — chạy trong WORKER (user BYPASSRLS), nên luôn lọc `org_id` tường minh. */
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
}
