import { Module } from '@nestjs/common';
import { LlmModule } from '../../infra/llm/llm.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { MAX_REPORT_MEETINGS } from './report-input.js';
import { ReportGenerationService } from './services/report-generation.service.js';
import { ReportSweepService } from './services/report-sweep.service.js';
import { ReportTickService } from './services/report-tick.service.js';
import { ReportsCoreModule } from './reports-core.module.js';
import { REPORT_OPTIONS } from './reports.tokens.js';
import type { ReportGenerationOptions } from './reports.types.js';

const MINUTE = 60_000;

/**
 * Tạo báo cáo — CHỈ tiến trình worker import (cần LLM). Api chỉ cần `ReportsCoreModule` để xếp job.
 */
@Module({
  imports: [ReportsCoreModule, LlmModule, NotificationsCoreModule],
  providers: [
    ReportGenerationService,
    ReportTickService,
    ReportSweepService,
    {
      provide: REPORT_OPTIONS,
      useValue: {
        // SDK: timeout 10 phút × (maxRetries 2 + 1) = 30 phút cho một lần gọi; + biên.
        leaseMs: 35 * MINUTE,
        maxMeetings: MAX_REPORT_MEETINGS,
      } satisfies ReportGenerationOptions,
    },
  ],
  exports: [ReportGenerationService, ReportTickService, ReportSweepService],
})
export class ReportsWorkerModule {}
