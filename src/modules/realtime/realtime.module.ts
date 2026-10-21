import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MeetingsModule } from '../meetings/meetings.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { RealtimeSubscriptionsService } from './realtime-subscriptions.service.js';
import { RealtimeGateway } from './realtime.gateway.js';

/** Socket.IO gateway `/realtime` (M7). Chỉ tiến trình api import; worker phát event qua Redis (B4). */
@Module({
  imports: [AuthModule, OrganizationsModule, MeetingsModule],
  providers: [RealtimeGateway, RealtimeSubscriptionsService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
