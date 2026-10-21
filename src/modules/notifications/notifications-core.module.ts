import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationFanoutService } from './services/notification-fanout.service.js';
import { NotificationsService } from './services/notifications.service.js';

/**
 * Phần KHÔNG có HTTP của thông báo — dùng chung cho api (ghi trong transaction, enqueue fan-out) và
 * worker (chạy fan-out). Worker import module này mà không kéo theo controller.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QueueName.Default })],
  providers: [NotificationsRepository, NotificationsService, NotificationFanoutService],
  exports: [NotificationsService, NotificationFanoutService],
})
export class NotificationsCoreModule {}
