import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { InviteAcceptanceController } from './controllers/invite-acceptance.controller.js';
import { InviteAcceptanceService } from './services/invite-acceptance.service.js';
import { InvitesController } from './controllers/invites.controller.js';
import { InvitesRepository } from './repositories/invites.repository.js';
import { InvitesService } from './services/invites.service.js';
import { JoinRequestsController } from './controllers/join-requests.controller.js';
import { JoinRequestsRepository } from './repositories/join-requests.repository.js';
import { JoinRequestsService } from './services/join-requests.service.js';

/** Link mời + yêu cầu tham gia. Phụ thuộc một chiều: invites → organizations (guard, membership). */
@Module({
  imports: [OrganizationsModule, NotificationsCoreModule],
  controllers: [InvitesController, InviteAcceptanceController, JoinRequestsController],
  providers: [
    InvitesRepository,
    InvitesService,
    JoinRequestsRepository,
    JoinRequestsService,
    InviteAcceptanceService,
  ],
})
export class InvitesModule {}
