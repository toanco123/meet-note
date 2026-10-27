import { Injectable, Logger } from '@nestjs/common';
import { ReportScheduler } from '../report.scheduler.js';
import { ReportsRepository } from '../reports.repository.js';
import type { ReportSweepResult } from '../reports.types.js';

/**
 * Lâu hơn mọi khoảng chờ retry bình thường (backoff 30 s → 4 phút) và khe giữa "commit dòng" và "job
 * nhận việc". Báo cáo đang chạy thật thì có lease → không bị quét dù LLM chậm.
 */
export const REPORT_STUCK_AFTER_MS = 10 * 60_000;

/**
 * Quét báo cáo tuần kẹt (M9 B7) — chạy trong worker (BYPASSRLS, xuyên tổ chức). Kẹt xảy ra khi chuỗi
 * job đứt: tick/regenerate commit `pending` rồi Redis lỗi lúc enqueue; worker chết cứng giữa lúc tạo
 * (lease hết hạn, không ai nhả). Quét chỉ BẢO ĐẢM TIẾN TRIỂN — đúng đắn vẫn ở `claim` (lease +
 * `generation`): job thừa nếu có chỉ nhận 0 dòng rồi bỏ qua. Cùng khuôn `MeetingSweepService` (M6 B8).
 */
@Injectable()
export class ReportSweepService {
  private readonly logger = new Logger(ReportSweepService.name);

  constructor(
    private readonly repo: ReportsRepository,
    private readonly scheduler: ReportScheduler,
  ) {}

  async sweep({
    idleMs = REPORT_STUCK_AFTER_MS,
    batchSize = 100,
    maxRows = 1_000,
  }: { idleMs?: number; batchSize?: number; maxRows?: number } = {}): Promise<ReportSweepResult> {
    const result: ReportSweepResult = { requeued: [], skipped: [] };
    let after: { updatedAt: string; id: string } | undefined;
    for (let seen = 0; seen < maxRows;) {
      const batch = await this.repo.findStuck(idleMs, batchSize, after);
      for (const report of batch) {
        if (await this.scheduler.hasLiveJob(report.id, report.generation)) {
          result.skipped.push(report.id);
          continue;
        }
        await this.scheduler.requeue(
          { reportId: report.id, generation: report.generation, requestId: null },
          report.version,
        );
        result.requeued.push(report.id);
        this.logger.warn(
          { reportId: report.id, status: report.status, generation: report.generation },
          'Báo cáo kẹt → xếp lại job tạo',
        );
      }
      seen += batch.length;
      const last = batch.at(-1);
      if (!last || batch.length < batchSize) break;
      after = { updatedAt: last.updatedAt, id: last.id };
    }
    return result;
  }
}
