import { Injectable } from '@nestjs/common';
import { buildSeries, buildTotals, resolveRange } from '../dashboard-range.js';
import type { DashboardGranularity, DashboardOverview } from '../dashboard.types.js';
import { DashboardLiveRepository } from '../repositories/dashboard-live.repository.js';
import { DashboardRepository } from '../repositories/dashboard.repository.js';
import { localDate } from '../../reports/report-week.js';

/** Số kênh trong "kênh hoạt động nhiều nhất". */
export const TOP_CHANNELS = 5;

/**
 * Dashboard tổ chức (M17): ghép rollup theo ngày (số cộng được) với các số tính trực tiếp (người hoạt động
 * phân biệt, dung lượng, top kênh, việc). Quyền (Owner / Admin) kiểm ở controller bằng
 * `org.dashboard.read`; service chỉ nhận `orgId` đã được xác nhận và CHỈ trả số — không tiêu đề, không
 * nội dung, không tên người (D2).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly rollup: DashboardRepository,
    private readonly live: DashboardLiveRepository,
  ) {}

  async overview(
    orgId: string,
    query: { from?: string; to?: string; granularity?: DashboardGranularity },
    now: Date = new Date(),
  ): Promise<DashboardOverview> {
    const today = localDate(now);
    const range = resolveRange(query.from, query.to, today);
    const granularity = query.granularity ?? 'day';

    const [rows, members, storage, topChannels, actionItems] = await Promise.all([
      this.rollup.readRange(orgId, range.from, range.to),
      this.live.memberCounts(orgId, range.from, range.to),
      this.live.storage(orgId),
      this.live.topChannels(orgId, range.from, range.to, TOP_CHANNELS),
      this.live.actionItemCounts(orgId, today, range.from, range.to),
    ]);

    const latest = rows.reduce<Date | null>(
      (acc, r) => (acc === null || r.computedAt > acc ? r.computedAt : acc),
      null,
    );
    return {
      range,
      granularity,
      totals: buildTotals(rows),
      series: buildSeries(rows, range, granularity),
      members,
      storage,
      topChannels,
      actionItems,
      computedAt: latest?.toISOString() ?? null,
    };
  }
}
