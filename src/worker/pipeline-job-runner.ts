import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import type { MeetingFailureCode } from '../infra/database/schema/index.js';
import type { MeetingJobData } from '../infra/queue/queue.types.js';
import { PermanentPipelineError } from '../modules/meetings/meeting-pipeline.errors.js';
import type { PipelineJob, PipelineStep } from '../modules/meetings/meetings.types.js';
import { MeetingPipelineService } from '../modules/meetings/services/meeting-pipeline.service.js';

/** Hết lượt retry vì lỗi TẠM → mã + câu cho người dùng theo bước. */
const EXHAUSTED: Record<PipelineStep, { code: MeetingFailureCode; message: string }> = {
  preprocess: {
    code: 'PREPROCESS_FAILED',
    message: 'Không xử lý được file ghi âm. Hãy thử chạy lại.',
  },
  transcribe: {
    code: 'TRANSCRIBE_FAILED',
    message: 'Không nhận dạng được giọng nói. Hãy thử chạy lại.',
  },
  summarize: { code: 'SUMMARIZE_FAILED', message: 'Không tạo được bản tóm tắt. Hãy thử chạy lại.' },
};

/** Job M5 enqueue trước M6 không có `attempt` → 1 (jobId `…a1`). */
function toPipelineJob(data: MeetingJobData): PipelineJob {
  return { meetingId: data.meetingId, attempt: data.attempt ?? 1, requestId: data.requestId };
}

/**
 * Cầu nối BullMQ ↔ `MeetingPipelineService` cho MỌI processor có job pipeline (M6 B5).
 *
 * - Lỗi vĩnh viễn → đánh `failed` (có `failure_code`) NGAY, ném `UnrecoverableError` → BullMQ không
 *   retry. Lỗi tạm → ném nguyên → BullMQ retry theo backoff.
 * - BẪY: sự kiện `failed` bắn ở MỖI lần thử thất bại, không chỉ lần cuối → `onFailed` chỉ đánh
 *   `failed` khi đã HẾT lượt (`attemptsMade >= attempts`).
 * - Tắt êm: `beforeApplicationShutdown` chạy TRƯỚC `onApplicationShutdown` (nơi @nestjs/bullmq gọi
 *   `worker.close()`, chờ job đang chạy) → huỷ job (kill whisper qua AbortSignal, pipeline nhả lease)
 *   rồi đưa job về `delayed` (`DelayedError`) — KHÔNG tính một lần thử; worker khác chạy tiếp.
 */
@Injectable()
export class PipelineJobRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PipelineJobRunner.name);
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  private shuttingDown = false;

  constructor(private readonly pipeline: MeetingPipelineService) {}

  async run(step: PipelineStep, job: Job<MeetingJobData>, token?: string): Promise<unknown> {
    const data = toPipelineJob(job.data);
    const controller = new AbortController();
    const options = {
      signal: controller.signal,
      onProgress: (_step: PipelineStep, percent: number) => void job.updateProgress(percent),
    };
    const work =
      step === 'preprocess'
        ? this.pipeline.preprocess(data, options)
        : step === 'transcribe'
          ? this.pipeline.transcribe(data, options)
          : this.pipeline.summarize(data, options);
    const key = job.id ?? `${job.name}:${data.meetingId}`;
    this.running.set(key, { controller, done: work.catch(() => undefined) });
    try {
      return { outcome: await work };
    } catch (error) {
      if (this.shuttingDown && controller.signal.aborted) {
        await job.moveToDelayed(Date.now() + 1_000, token);
        throw new DelayedError();
      }
      if (error instanceof PermanentPipelineError) {
        await this.pipeline.fail(data, error.code, error.userMessage);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      this.running.delete(key);
    }
  }

  async onFailed(
    step: PipelineStep,
    job: Job<MeetingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    if (error.name === 'UnrecoverableError') return; // đã đánh `failed` trong `run`
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // còn lượt — BullMQ sẽ chạy lại
    const exhausted = EXHAUSTED[step];
    await this.pipeline.fail(toPipelineJob(job.data), exhausted.code, exhausted.message);
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
