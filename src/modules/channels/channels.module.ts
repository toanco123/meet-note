import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { ChannelMembersController } from './channel-members.controller.js';
import { ChannelMembersRepository } from './channel-members.repository.js';
import { ChannelMembersService } from './channel-members.service.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsRepository } from './channels.repository.js';
import { ChannelsService } from './channels.service.js';
import { ChannelAccessGuard } from './guards/channel-access.guard.js';
import { ChannelPermissionGuard } from './guards/channel-permission.guard.js';

@Module({
  // OrganizationsModule export OrgMemberGuard (+ repository nó cần) → @RequireOrgPermission và
  // @RequireChannelPermission resolve được guard trong module này.
  imports: [OrganizationsModule],
  controllers: [ChannelsController, ChannelMembersController],
  providers: [
    ChannelsRepository,
    ChannelsService,
    ChannelMembersRepository,
    ChannelMembersService,
    ChannelAccessGuard,
    ChannelPermissionGuard,
  ],
})
export class ChannelsModule {}
