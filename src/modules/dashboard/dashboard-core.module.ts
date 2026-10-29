import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueName } from '../../infra/queue/queue.module.js';
import { DashboardLiveRepository } from './repositories/dashboard-live.repository.js';
import { DashboardRepository } from './repositories/dashboard.repository.js';
import { StatsRollupService } from './services/stats-rollup.service.js';
import { StatsTickService } from './services/stats-tick.service.js';
import { StatsScheduler } from './stats.scheduler.js';

/**
 * Phần không-HTTP của dashboard (M17), dùng chung api + worker: api xếp job khi xoá / sửa meeting, worker
 * tính rollup. Không controller.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QueueName.Default })],
  providers: [
    DashboardRepository,
    DashboardLiveRepository,
    StatsScheduler,
    StatsRollupService,
    StatsTickService,
  ],
  exports: [
    DashboardRepository,
    DashboardLiveRepository,
    StatsScheduler,
    StatsRollupService,
    StatsTickService,
  ],
})
export class DashboardCoreModule {}
