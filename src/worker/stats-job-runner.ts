import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { StatsRollupJobData } from '../infra/queue/queue.types.js';
import { StatsRollupService } from '../modules/dashboard/services/stats-rollup.service.js';
import { StatsTickService } from '../modules/dashboard/services/stats-tick.service.js';

/** Vỏ mỏng của job rollup dashboard (M17): logic ở service để test không cần BullMQ. */
@Injectable()
export class StatsJobRunner {
  constructor(
    private readonly rollup: StatsRollupService,
    private readonly tick: StatsTickService,
  ) {}

  async runRollup(job: Job<StatsRollupJobData>): Promise<{ days: number }> {
    const { orgId, day, span } = job.data;
    return { days: await this.rollup.rollup(orgId, day, span) };
  }

  runTick(): Promise<{ enqueued: number }> {
    return this.tick.tick();
  }

  runReconcile(): Promise<{ enqueued: number }> {
    return this.tick.reconcile();
  }
}
