import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { JobName } from '../infra/queue/jobs.js';
import { QueueName } from '../infra/queue/queue.module.js';
import type {
  MeetingJobData,
  NotificationFanoutJobData,
  StatsRollupJobData,
  WeeklyReportGenerateJobData,
  WeeklyReportTickJobData,
} from '../infra/queue/queue.types.js';
import { NotificationFanoutService } from '../modules/notifications/services/notification-fanout.service.js';
import { MaintenanceJobRunner } from './maintenance-job-runner.js';
import { PipelineJobRunner } from './pipeline-job-runner.js';
import { ReportJobRunner } from './report-job-runner.js';
import { StatsJobRunner } from './stats-job-runner.js';

/**
 * MỘT processor cho queue `default`, dispatch theo `job.name`. Không tách mỗi domain một
 * `@Processor('default')`: BullMQ Worker không lọc job theo tên — hai Worker cùng queue giành job
 * của nhau, bên nhận nhầm tên sẽ làm hỏng job (M10 bài học 7). Logic nằm ở service.
 *
 * Chỉ `WorkerModule` đăng ký class này — nằm trong module mà `AppModule` import thì api cũng ăn job.
 */
@Processor(QueueName.Default, { concurrency: 4 })
export class DefaultQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(DefaultQueueProcessor.name);

  constructor(
    private readonly fanout: NotificationFanoutService,
    private readonly pipeline: PipelineJobRunner,
    private readonly maintenance: MaintenanceJobRunner,
    private readonly reports: ReportJobRunner,
    private readonly stats: StatsJobRunner,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<unknown> {
    switch (job.name) {
      case JobName.NotificationFanout:
        return { created: await this.fanout.run(job.data as NotificationFanoutJobData) };
      case JobName.MeetingPreprocess:
        return this.pipeline.run('preprocess', job as Job<MeetingJobData>, token);
      case JobName.MeetingSummarize:
        return this.pipeline.run('summarize', job as Job<MeetingJobData>, token);
      // Việc định kỳ (M6 B8): kết quả đếm được lưu làm `returnvalue` của job — xem lại trong Redis.
      case JobName.MeetingSweepStuck:
        return this.maintenance.sweepStuckMeetings();
      case JobName.ReportSweepStuck:
        return this.maintenance.sweepStuckReports();
      case JobName.UploadCleanup:
        return this.maintenance.cleanupUploads();
      case JobName.IdempotencyCleanup:
        return this.maintenance.cleanupIdempotencyKeys();
      case JobName.ChannelPurge:
        return this.maintenance.purgeChannels();
      // Báo cáo tuần (M9): tick fan-out theo lịch / backfill, generate cho từng báo cáo.
      case JobName.WeeklyReportTick:
        return this.reports.runTick(job as Job<WeeklyReportTickJobData>);
      case JobName.WeeklyReportGenerate:
        return this.reports.runGenerate(job as Job<WeeklyReportGenerateJobData>, token);
      // Rollup dashboard (M17): tick 5 phút / đêm fan-out; rollup tính lại MỘT (tổ chức, ngày).
      case JobName.StatsTick:
        return this.stats.runTick();
      case JobName.StatsReconcile:
        return this.stats.runReconcile();
      case JobName.StatsRollup:
        return this.stats.runRollup(job as Job<StatsRollupJobData>);
      default:
        throw new UnrecoverableError(`Job không xác định: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (job?.name === JobName.MeetingPreprocess || job?.name === JobName.MeetingSummarize) {
      const step = job.name === JobName.MeetingPreprocess ? 'preprocess' : 'summarize';
      return this.pipeline.onFailed(step, job as Job<MeetingJobData>, error);
    }
    if (job?.name === JobName.WeeklyReportGenerate) {
      return this.reports.onGenerateFailed(job as Job<WeeklyReportGenerateJobData>, error);
    }
    this.logger.error(
      {
        err: error,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        requestId: job?.data?.requestId,
      },
      `Job ${job?.name} lỗi`,
    );
  }
}
