import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName, reportJobId } from '../../infra/queue/jobs.js';
import { QueueName } from '../../infra/queue/queue.module.js';
import type { WeeklyReportGenerateJobData } from '../../infra/queue/queue.types.js';
import type { ReportJob } from './reports.types.js';

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
}
