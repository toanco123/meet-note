import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsCoreModule } from './reports-core.module.js';
import { ReportsService } from './services/reports.service.js';

/** API báo cáo tuần (M9 B6). Việc tạo báo cáo nằm ở `ReportsWorkerModule` (cần LLM, chỉ worker). */
@Module({
  imports: [OrganizationsModule, ChannelsModule, ReportsCoreModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
