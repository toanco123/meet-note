import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { QueueName } from './infra/queue/queue.module.js';
import { MeetingsPipelineModule } from './modules/meetings/meetings-pipeline.module.js';
import { NotificationsCoreModule } from './modules/notifications/notifications-core.module.js';
import { DefaultQueueProcessor } from './worker/default-queue.processor.js';
import { PipelineJobRunner } from './worker/pipeline-job-runner.js';
import { TranscriptionQueueProcessor } from './worker/transcription-queue.processor.js';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service.js';
import { workerQueues } from './worker/worker-queues.js';

const queues = workerQueues();

/**
 * Root module của tiến trình worker: không có controller, không mở cổng HTTP.
 * Processor BullMQ đăng ký Ở ĐÂY (một processor mỗi queue, chỉ queue có trong `WORKER_QUEUES`),
 * service lấy từ `XxxCoreModule` / `MeetingsPipelineModule` của domain.
 */
@Module({
  imports: [CoreModule, NotificationsCoreModule, MeetingsPipelineModule],
  providers: [
    WorkerHeartbeatService,
    PipelineJobRunner,
    ...(queues.has(QueueName.Default) ? [DefaultQueueProcessor] : []),
    ...(queues.has(QueueName.Transcription) ? [TranscriptionQueueProcessor] : []),
  ],
})
export class WorkerModule {}
