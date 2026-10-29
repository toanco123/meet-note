import { Injectable, Logger } from '@nestjs/common';
import { localDate } from '../../reports/report-week.js';
import { DashboardRepository } from '../repositories/dashboard.repository.js';
import { StatsScheduler } from '../stats.scheduler.js';

const MINUTE = 60_000;
/** Tick 5 phút nhìn lại 10 phút: một lần tick bị lỡ vẫn được lần sau phủ. */
export const TICK_LOOKBACK_MS = 10 * MINUTE;
export const TICK_BUCKET_MS = 5 * MINUTE;
/** Số ngày job đêm tính lại cho mỗi tổ chức. */
export const RECONCILE_DAYS = 35;
const TICK_MAX_PAIRS = 1_000;
const ORG_BATCH = 500;

/**
 * Hai lịch của rollup (M17 B2). Cả hai chỉ FAN-OUT job `stats.rollup` — không tự tính — để một lần chạy
 * không giữ một slot của queue `default` lâu, và mỗi (tổ chức, ngày) có retry riêng.
 */
@Injectable()
export class StatsTickService {
  private readonly logger = new Logger(StatsTickService.name);

  constructor(
    private readonly repo: DashboardRepository,
    private readonly scheduler: StatsScheduler,
  ) {}

  /**
   * Mỗi 5 phút: các (tổ chức, ngày VN của `recorded_at`) có meeting đổi trong 10 phút qua. Lấy NGÀY CỦA
   * CHÍNH MEETING đổi — không phải "hôm nay / hôm qua": pipeline có thể xong một meeting họp từ tuần
   * trước, ngày đó cũng phải được tính lại. Cùng ô 5 phút → cùng jobId → tick chạy lại không nhân đôi.
   */
  async tick(now: Date = new Date()): Promise<{ enqueued: number }> {
    const since = new Date(now.getTime() - TICK_LOOKBACK_MS);
    const pairs = await this.repo.findChangedDays(since, TICK_MAX_PAIRS);
    const bucket = Math.floor(now.getTime() / TICK_BUCKET_MS);
    for (const { orgId, day } of pairs) {
      await this.scheduler.enqueueRollup({ orgId, day }, `t${bucket}`);
    }
    if (pairs.length === TICK_MAX_PAIRS) {
      this.logger.warn({ pairs: pairs.length }, 'Tick chạm trần — phần còn lại để job đêm');
    }
    return { enqueued: pairs.length };
  }

  /**
   * Hằng đêm: mỗi tổ chức tính lại `RECONCILE_DAYS` ngày gần nhất — lưới an toàn cho mọi thứ tick / sự
   * kiện bỏ sót (Redis lỗi lúc enqueue, sửa trực tiếp trong DB…). MỘT job cho mỗi tổ chức (`span`).
   */
  async reconcile(now: Date = new Date(), batchSize = ORG_BATCH): Promise<{ enqueued: number }> {
    const today = localDate(now);
    let enqueued = 0;
    for (let after: string | undefined; ;) {
      const orgIds = await this.repo.listOrgIds(after, batchSize);
      for (const orgId of orgIds) {
        await this.scheduler.enqueueRollup(
          { orgId, day: today, span: RECONCILE_DAYS },
          `n${today}`,
        );
        enqueued++;
      }
      if (orgIds.length < batchSize) break;
      after = orgIds[orgIds.length - 1];
    }
    return { enqueued };
  }
}
