import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { DashboardCoreModule } from './dashboard-core.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './services/dashboard.service.js';

/** API dashboard tổ chức (M17). Phần rollup / job nằm ở `DashboardCoreModule` (dùng chung api + worker). */
@Module({
  imports: [OrganizationsModule, DashboardCoreModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
