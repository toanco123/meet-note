import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName, statsRollupJobId } from '../../infra/queue/jobs.js';
import { QueueName } from '../../infra/queue/queue.module.js';
import type { StatsRollupJobData } from '../../infra/queue/queue.types.js';

/**
 * Xếp job rollup dashboard (M17) — api (xoá / sửa meeting) và worker (tick, đêm) dùng chung. Gọi SAU
 * commit. Retry nhẹ (3 lần, backoff mũ từ 10 s): việc là MỘT câu SQL, lỗi thường là DB bận.
 */
@Injectable()
export class StatsScheduler {
  constructor(@InjectQueue(QueueName.Default) private readonly queue: Queue<StatsRollupJobData>) {}

  /** `suffix` quyết định "cùng yêu cầu hay yêu cầu mới" — xem `statsRollupJobId`. */
  async enqueueRollup(job: StatsRollupJobData, suffix: string): Promise<void> {
    await this.queue.add(JobName.StatsRollup, job, {
      jobId: statsRollupJobId(job.orgId, job.day, suffix),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    });
  }

  /** Dữ liệu nguồn của một ngày vừa đổi (xoá meeting, sửa `recorded_at`): tính lại ngay, không đợi tick. */
  enqueueDayChanged(orgId: string, day: string, requestId: string | null = null): Promise<void> {
    return this.enqueueRollup({ orgId, day, requestId }, `e${Date.now()}`);
  }
}
