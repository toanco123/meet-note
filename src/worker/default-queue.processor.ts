import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { JobName } from '../infra/queue/jobs.js';
import { QueueName } from '../infra/queue/queue.module.js';
import type { MeetingJobData, NotificationFanoutJobData } from '../infra/queue/queue.types.js';
import { NotificationFanoutService } from '../modules/notifications/services/notification-fanout.service.js';
import { PipelineJobRunner } from './pipeline-job-runner.js';

/**
 * MỘT processor cho queue `default`, dispatch theo `job.name`. Không tách mỗi domain một
 * `@Processor('default')`: BullMQ Worker không lọc job theo tên — hai Worker cùng queue giành job
 * của nhau, bên nhận nhầm tên sẽ làm hỏng job (M10 bài học 7). Logic nằm ở service.
 *
 * Chỉ `WorkerModule` đăng ký class này — nằm trong module mà `AppModule` import thì api cũng ăn job.
 */
@Processor(QueueName.Default, { concurrency: 4 })
export class DefaultQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DefaultQueueProcessor.name);

  constructor(
    private readonly fanout: NotificationFanoutService,
    private readonly pipeline: PipelineJobRunner,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<unknown> {
    switch (job.name) {
      case JobName.NotificationFanout:
        return { created: await this.fanout.run(job.data as NotificationFanoutJobData) };
      case JobName.MeetingPreprocess:
        return this.pipeline.run('preprocess', job as Job<MeetingJobData>, token);
      case JobName.MeetingSummarize:
        return this.pipeline.run('summarize', job as Job<MeetingJobData>, token);
      default:
        throw new UnrecoverableError(`Job không xác định: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (job?.name === JobName.MeetingPreprocess || job?.name === JobName.MeetingSummarize) {
      const step = job.name === JobName.MeetingPreprocess ? 'preprocess' : 'summarize';
      return this.pipeline.onFailed(step, job as Job<MeetingJobData>, error);
    }
    this.logger.error(
      {
        err: error,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        requestId: job?.data?.requestId,
      },
      `Job ${job?.name} lỗi`,
    );
  }
}
