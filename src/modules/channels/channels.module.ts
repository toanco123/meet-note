import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ChannelMembersController } from './controllers/channel-members.controller.js';
import { ChannelMembersRepository } from './repositories/channel-members.repository.js';
import { ChannelMembersService } from './services/channel-members.service.js';
import { ChannelsController } from './controllers/channels.controller.js';
import { ChannelsRepository } from './repositories/channels.repository.js';
import { ChannelsPurgeService } from './services/channels-purge.service.js';
import { ChannelsService } from './services/channels.service.js';
import { ChannelAccessGuard } from './guards/channel-access.guard.js';
import { ChannelPermissionGuard } from './guards/channel-permission.guard.js';

@Module({
  // OrganizationsModule export OrgMemberGuard (+ repository nó cần) → @RequireOrgPermission và
  // @RequireChannelPermission resolve được guard trong module này.
  imports: [OrganizationsModule, NotificationsModule],
  controllers: [ChannelsController, ChannelMembersController],
  providers: [
    ChannelsRepository,
    ChannelsService,
    ChannelsPurgeService,
    ChannelMembersRepository,
    ChannelMembersService,
    ChannelAccessGuard,
    ChannelPermissionGuard,
  ],
  // M6b: meetings dùng `findAccess` (lọc theo kênh) và guard kênh (`/channels/:id/meetings`).
  exports: [ChannelsRepository, ChannelAccessGuard, ChannelPermissionGuard],
})
export class ChannelsModule {}
