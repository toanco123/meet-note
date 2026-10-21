import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { NotificationsController } from './notifications.controller.js';

/** Thông báo in-app (M10) — API của chính người dùng. Module domain khác import `NotificationsCoreModule`. */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsController],
})
export class NotificationsModule {}
