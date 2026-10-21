import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { NotificationsCoreModule } from './modules/notifications/notifications-core.module.js';
import { DefaultQueueProcessor } from './worker/default-queue.processor.js';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service.js';

/**
 * Root module của tiến trình worker: không có controller, không mở cổng HTTP.
 * Processor BullMQ đăng ký Ở ĐÂY (một processor mỗi queue), service lấy từ `XxxCoreModule` của domain.
 */
@Module({
  imports: [CoreModule, NotificationsCoreModule],
  providers: [WorkerHeartbeatService, DefaultQueueProcessor],
})
export class WorkerModule {}
