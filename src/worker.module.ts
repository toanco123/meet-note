import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from './config/env.validation.js';
import { CoreModule } from './core.module.js';
import { QueueName } from './infra/queue/queue.module.js';
import { ChannelsCoreModule } from './modules/channels/channels-core.module.js';
import { DashboardCoreModule } from './modules/dashboard/dashboard-core.module.js';
import { IdempotencyModule } from './modules/idempotency/idempotency.module.js';
import { MeetingsPipelineModule } from './modules/meetings/meetings-pipeline.module.js';
import { NotificationsCoreModule } from './modules/notifications/notifications-core.module.js';
import { ReportsWorkerModule } from './modules/reports/reports-worker.module.js';
import { UploadsCoreModule } from './modules/uploads/uploads-core.module.js';
import { DefaultQueueProcessor } from './worker/default-queue.processor.js';
import { MaintenanceJobRunner } from './worker/maintenance-job-runner.js';
import { PipelineJobRunner } from './worker/pipeline-job-runner.js';
import { ReportJobRunner } from './worker/report-job-runner.js';
import { StatsJobRunner } from './worker/stats-job-runner.js';
import { TranscriptionQueueProcessor } from './worker/transcription-queue.processor.js';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service.js';
import { workerQueues } from './worker/worker-queues.js';
import { WORKER_SCHEDULES_ENABLED, WorkerSchedules } from './worker/worker-schedules.js';

const queues = workerQueues();

/**
 * Root module của tiến trình worker: không có controller, không mở cổng HTTP.
 * Processor BullMQ đăng ký Ở ĐÂY (một processor mỗi queue, chỉ queue có trong `WORKER_QUEUES`),
 * service lấy từ `XxxCoreModule` / `MeetingsPipelineModule` của domain.
 */
@Module({
  imports: [
    CoreModule,
    BullModule.registerQueue({ name: QueueName.Default }),
    NotificationsCoreModule,
    MeetingsPipelineModule,
    ReportsWorkerModule,
    DashboardCoreModule,
    // Việc định kỳ (M6 B8): phần không-HTTP của các domain, không kéo controller / guard theo.
    ChannelsCoreModule,
    UploadsCoreModule,
    IdempotencyModule,
  ],
  providers: [
    WorkerHeartbeatService,
    PipelineJobRunner,
    ReportJobRunner,
    StatsJobRunner,
    MaintenanceJobRunner,
    // Lịch đăng ký ở MỌI worker, kể cả worker chỉ nghe `transcription`: upsert theo id nên vô hại,
    // và không phụ thuộc vào việc worker nào khởi động trước.
    WorkerSchedules,
    {
      provide: WORKER_SCHEDULES_ENABLED,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        config.get('WORKER_SCHEDULES_ENABLED', { infer: true }),
    },
    ...(queues.has(QueueName.Default) ? [DefaultQueueProcessor] : []),
    ...(queues.has(QueueName.Transcription) ? [TranscriptionQueueProcessor] : []),
  ],
})
export class WorkerModule {}
