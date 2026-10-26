import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import type {
  WeeklyReportGenerateJobData,
  WeeklyReportTickJobData,
} from '../infra/queue/queue.types.js';
import { PermanentReportError } from '../modules/reports/report.errors.js';
import { ReportGenerationService } from '../modules/reports/services/report-generation.service.js';
import { ReportTickService } from '../modules/reports/services/report-tick.service.js';
import { isWeekStart, previousWeekStart } from '../modules/reports/report-week.js';

/** Hết lượt retry vì lỗi TẠM → câu lưu ở `last_error` (người dùng đọc được, không chi tiết nội bộ). */
const EXHAUSTED_MESSAGE = 'Không tạo được báo cáo. Hãy thử tạo lại.';

/**
 * Thời điểm lịch BẮN cho job của Job Scheduler: job được tạo (`timestamp`) với `delay` tới mốc cron,
 * nên mốc bắn = `timestamp + delay`. Dùng nó thay vì `now()` lúc xử lý: tick bị trễ (worker sập, hàng
 * đợi dồn) vẫn ra đúng tuần.
 */
export function scheduledAt(job: Pick<Job, 'timestamp' | 'delay'>): Date {
  return new Date(job.timestamp + (job.delay ?? 0));
}

/**
 * Cầu nối BullMQ ↔ dịch vụ báo cáo tuần cho `DefaultQueueProcessor` (M9 B5), cùng khuôn với
 * `PipelineJobRunner` của meeting:
 * - Lỗi vĩnh viễn → `failed` NGAY + `UnrecoverableError`. Lỗi tạm → ném nguyên, BullMQ retry.
 * - BẪY (M6): sự kiện `failed` bắn ở MỖI lần thử → `onFailed` chỉ đánh `failed` khi HẾT lượt.
 * - Tắt êm: `beforeApplicationShutdown` huỷ job đang chạy (AbortSignal tới SDK, lease được nhả) rồi đưa
 *   về `delayed`; job lấy về SAU lúc đó cũng trả về `delayed` ngay, không chạy (M6 bài học 16).
 */
@Injectable()
export class ReportJobRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ReportJobRunner.name);
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  private shuttingDown = false;

  constructor(
    private readonly generation: ReportGenerationService,
    private readonly tick: ReportTickService,
  ) {}

  async runTick(job: Job<WeeklyReportTickJobData>): Promise<unknown> {
    const weekStart = job.data.weekStart ?? previousWeekStart(scheduledAt(job));
    // `weekStart` từ backfill là dữ liệu bên ngoài; sai thì không retry được gì.
    if (!isWeekStart(weekStart)) {
      throw new UnrecoverableError(
        `weekStart không hợp lệ (phải là Thứ Hai YYYY-MM-DD): ${weekStart}`,
      );
    }
    const result = await this.tick.run(weekStart, job.data.requestId ?? null);
    this.logger.log({ weekStart, ...result }, 'Tick báo cáo tuần xong');
    return { weekStart, ...result };
  }

  async runGenerate(job: Job<WeeklyReportGenerateJobData>, token?: string): Promise<unknown> {
    if (this.shuttingDown) {
      await job.moveToDelayed(Date.now() + 1_000, token);
      throw new DelayedError();
    }
    const data = job.data;
    const controller = new AbortController();
    const work = this.generation.generate(data, { signal: controller.signal });
    const key = job.id ?? `${job.name}:${data.reportId}`;
    this.running.set(key, { controller, done: work.catch(() => undefined) });
    try {
      return { outcome: await work };
    } catch (error) {
      if (this.shuttingDown && controller.signal.aborted) {
        await job.moveToDelayed(Date.now() + 1_000, token);
        throw new DelayedError();
      }
      if (error instanceof PermanentReportError) {
        await this.generation.fail(data, error.userMessage);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      this.running.delete(key);
    }
  }

  async onGenerateFailed(
    job: Job<WeeklyReportGenerateJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    if (error.name === 'UnrecoverableError') return; // đã đánh `failed` trong `runGenerate`
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // còn lượt — BullMQ sẽ chạy lại
    await this.generation.fail(job.data, EXHAUSTED_MESSAGE);
    this.logger.error(
      { err: error, jobId: job.id, requestId: job.data.requestId },
      `${job.name} hết lượt`,
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    const jobs = [...this.running.values()];
    for (const { controller } of jobs) controller.abort(new Error('Worker đang tắt'));
    await Promise.all(jobs.map((j) => j.done));
  }
}
