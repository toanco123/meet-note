import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobState, Queue } from 'bullmq';
import { JobName, reportJobId, reportRequeueJobId } from '../../infra/queue/jobs.js';
import { QueueName } from '../../infra/queue/queue.module.js';
import type { WeeklyReportGenerateJobData } from '../../infra/queue/queue.types.js';
import type { ReportJob } from './reports.types.js';

/** Job còn "sống": sẽ chạy hoặc đang chạy. `completed` / `failed` / mất (`unknown`) thì không. */
const LIVE_STATES = new Set<JobState | 'unknown'>([
  'waiting',
  'prioritized',
  'delayed',
  'active',
  'waiting-children',
]);

/**
 * Xếp job tạo báo cáo (M9) — api (tạo lại thủ công, B6) và worker (tick) dùng chung. Retry theo 06 §2:
 * 5 lần, backoff mũ từ 30 s (LLM 429 / 5xx thường tự hết sau vài phút). Gọi SAU commit.
 */
@Injectable()
export class ReportScheduler {
  constructor(
    @InjectQueue(QueueName.Default) private readonly queue: Queue<WeeklyReportGenerateJobData>,
  ) {}

  async enqueueGenerate(job: ReportJob): Promise<void> {
    await this.queue.add(JobName.WeeklyReportGenerate, job, {
      jobId: reportJobId(job.reportId, job.generation),
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  }

  /** Quét kẹt hỏi: job THƯỜNG của lần tạo này còn sống không? (đang chờ retry ≠ kẹt) */
  async hasLiveJob(reportId: string, generation: number): Promise<boolean> {
    return LIVE_STATES.has(await this.queue.getJobState(reportJobId(reportId, generation)));
  }

  /** Xếp LẠI (quét kẹt) — jobId riêng, xem `reportRequeueJobId`. */
  async requeue(job: ReportJob, version: string): Promise<void> {
    await this.queue.add(JobName.WeeklyReportGenerate, job, {
      jobId: reportRequeueJobId(job.reportId, job.generation, version),
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
    });
  }
}
