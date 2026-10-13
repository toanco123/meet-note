import { Module } from '@nestjs/common';
import { OrgMemberGuard } from './guards/org-member.guard.js';
import { OrgPermissionGuard } from './guards/org-permission.guard.js';
import { OrganizationMembersController } from './organization-members.controller.js';
import { OrganizationMembersRepository } from './organization-members.repository.js';
import { OrganizationMembersService } from './organization-members.service.js';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsRepository } from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

@Module({
  controllers: [OrganizationsController, OrganizationMembersController],
  // Guard dùng qua @UseGuards cần được DI resolve trong module của controller dùng nó.
  providers: [
    OrganizationsRepository,
    OrganizationsService,
    OrganizationMembersRepository,
    OrganizationMembersService,
    OrgMemberGuard,
    OrgPermissionGuard,
  ],
  // Export guard để module khác (M4: kênh) dùng @RequireOrgPermission trên controller của mình.
  exports: [OrganizationsRepository, OrganizationsService, OrgMemberGuard, OrgPermissionGuard],
})
export class OrganizationsModule {}
