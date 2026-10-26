import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { ReportScheduler } from './report.scheduler.js';
import { ReportsRepository } from './reports.repository.js';

/** Phần không-HTTP của báo cáo tuần dùng chung api + worker (M9): repository + xếp job. */
@Module({
  imports: [BullModule.registerQueue({ name: QueueName.Default })],
  providers: [ReportsRepository, ReportScheduler],
  exports: [ReportsRepository, ReportScheduler],
})
export class ReportsCoreModule {}
