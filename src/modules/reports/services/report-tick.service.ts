import { Injectable, Logger } from '@nestjs/common';
import { ReportScheduler } from '../report.scheduler.js';
import { ReportsRepository } from '../reports.repository.js';
import type { TickResult } from '../reports.types.js';

const BATCH = 200;

/**
 * Tick hằng tuần (M9 B5): chỉ FAN-OUT — không gọi LLM. Hai pha:
 * 1. tạo dòng `pending` cho mọi kênh đủ điều kiện (idempotent bằng `ON CONFLICT DO NOTHING`);
 * 2. xếp một job `generate` cho MỌI dòng `pending` của tuần (jobId cố định → trùng thì BullMQ bỏ qua).
 * Pha 2 duyệt theo dòng `pending`, không theo "dòng vừa chèn": tick trước chết giữa hai pha thì lần
 * chạy lại vẫn xếp đủ job. Một job enqueue lỗi không chặn các kênh khác; cuối cùng ném lỗi để BullMQ
 * chạy lại tick (đã idempotent) — chỉ phần còn thiếu được làm.
 */
@Injectable()
export class ReportTickService {
  private readonly logger = new Logger(ReportTickService.name);

  constructor(
    private readonly repo: ReportsRepository,
    private readonly scheduler: ReportScheduler,
  ) {}

  async run(weekStart: string, requestId: string | null = null): Promise<TickResult> {
    const result: TickResult = { channels: 0, created: 0, enqueued: 0 };

    let afterChannel: string | null = null;
    for (;;) {
      const batch = await this.repo.insertWeekRows(weekStart, afterChannel, BATCH);
      result.channels += batch.scanned;
      result.created += batch.inserted;
      if (batch.scanned < BATCH || !batch.lastChannelId) break;
      afterChannel = batch.lastChannelId;
    }

    let failures = 0;
    let afterReport: string | null = null;
    for (;;) {
      const pending = await this.repo.pendingOfWeek(weekStart, afterReport, BATCH);
      for (const report of pending) {
        try {
          await this.scheduler.enqueueGenerate({
            reportId: report.id,
            generation: report.generation,
            requestId,
          });
          result.enqueued += 1;
        } catch (error) {
          failures += 1;
          this.logger.error({ err: error, reportId: report.id, weekStart }, 'Enqueue báo cáo lỗi');
        }
      }
      if (pending.length < BATCH) break;
      afterReport = pending[pending.length - 1]!.id;
    }
    if (failures > 0) {
      throw new Error(`Tick ${weekStart}: ${failures} báo cáo chưa xếp được job (sẽ thử lại)`);
    }
    return result;
  }
}
