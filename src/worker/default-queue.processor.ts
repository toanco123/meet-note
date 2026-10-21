import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { JobName } from '../infra/queue/jobs.js';
import { QueueName } from '../infra/queue/queue.module.js';
import type { NotificationFanoutJobData } from '../infra/queue/queue.types.js';
import { NotificationFanoutService } from '../modules/notifications/services/notification-fanout.service.js';

/** `meeting.preprocess` chưa có pipeline (M6 hoãn) → cất lại ngần này rồi thử lại. */
const PARK_MS = 60 * 60 * 1000;

/**
 * MỘT processor cho queue `default`, dispatch theo `job.name`. Không tách mỗi domain một
 * `@Processor('default')`: BullMQ Worker không lọc job theo tên — hai Worker cùng queue giành job
 * của nhau, bên nhận nhầm tên sẽ làm hỏng job. Logic nằm ở service (test được không cần BullMQ).
 *
 * Chỉ `WorkerModule` đăng ký class này — nằm trong module mà `AppModule` import thì api cũng ăn job.
 */
@Processor(QueueName.Default, { concurrency: 5 })
export class DefaultQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DefaultQueueProcessor.name);

  constructor(private readonly fanout: NotificationFanoutService) {
    super();
  }

  async process(job: Job, token?: string): Promise<unknown> {
    switch (job.name) {
      case JobName.NotificationFanout:
        return { created: await this.fanout.run(job.data as NotificationFanoutJobData) };
      case JobName.MeetingPreprocess:
        // M5 đã enqueue job này nhưng M6 (pipeline) còn hoãn. Ném lỗi thì job thành `failed` và
        // jobId cũ chặn enqueue lại; nên đẩy về `delayed` — không tính là một lần thử. Bỏ khi làm M6.
        await job.moveToDelayed(Date.now() + PARK_MS, token);
        throw new DelayedError();
      default:
        throw new UnrecoverableError(`Job không xác định: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
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
