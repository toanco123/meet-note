import { Module } from '@nestjs/common';
import { OrganizationsRepository } from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  providers: [OrganizationsRepository, OrganizationsService],
  exports: [OrganizationsRepository, OrganizationsService],
})
export class OrganizationsModule {}
