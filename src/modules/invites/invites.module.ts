import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { InvitesController } from './invites.controller.js';
import { InvitesRepository } from './invites.repository.js';
import { InvitesService } from './invites.service.js';

/** Link mời + yêu cầu tham gia. Phụ thuộc một chiều: invites → organizations (guard, membership). */
@Module({
  imports: [OrganizationsModule],
  controllers: [InvitesController],
  providers: [InvitesRepository, InvitesService],
})
export class InvitesModule {}
