import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { InviteAcceptanceController } from './invite-acceptance.controller.js';
import { InviteAcceptanceService } from './invite-acceptance.service.js';
import { InvitesController } from './invites.controller.js';
import { InvitesRepository } from './invites.repository.js';
import { InvitesService } from './invites.service.js';
import { JoinRequestsRepository } from './join-requests.repository.js';

/** Link mời + yêu cầu tham gia. Phụ thuộc một chiều: invites → organizations (guard, membership). */
@Module({
  imports: [OrganizationsModule],
  controllers: [InvitesController, InviteAcceptanceController],
  providers: [InvitesRepository, InvitesService, JoinRequestsRepository, InviteAcceptanceService],
})
export class InvitesModule {}
