import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { WorkerHeartbeatService } from './worker/worker-heartbeat.service.js';

/**
 * Root module của tiến trình worker: không có controller, không mở cổng HTTP.
 * Các processor BullMQ (M6+) được thêm vào đây qua `XxxCoreModule` của từng domain.
 */
@Module({
  imports: [CoreModule],
  providers: [WorkerHeartbeatService],
})
export class WorkerModule {}
