import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import {
  NotificationFanoutService,
  reportReadyKey,
} from '../../notifications/services/notification-fanout.service.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import { LlmPermanentError } from '../../../infra/llm/llm.errors.js';
import { REPORT_WRITER } from '../../../infra/llm/llm.module.js';
import type { ReportWriter } from '../../../infra/llm/llm.types.js';
import {
  buildReportInput,
  MAX_OVERDUE_ACTION_ITEMS,
  selectMeetings,
  selectOverdueItems,
} from '../report-input.js';
import { PermanentReportError } from '../report.errors.js';
import { REPORT_OPTIONS } from '../reports.tokens.js';
import { ReportsRepository } from '../reports.repository.js';
import type {
  ClaimedReport,
  ReportGenerationOptions,
  ReportJob,
  ReportOutcome,
} from '../reports.types.js';

/** Dưới ngần này meeting thì không có gì để tổng hợp (D8): `skipped`, không gọi LLM. */
export const MIN_MEETINGS_FOR_REPORT = 2;

/**
 * Tạo MỘT phiên bản báo cáo tuần (M9 B4), KHÔNG phụ thuộc BullMQ (processor ở B5 chỉ gọi vào đây) →
 * test được với Postgres thật và `ReportWriter` giả.
 *
 * (1) NHẬN VIỆC bằng lease + fencing token (`claim`) — job cũ / trùng / đã xong → `ignored`;
 * (2) việc chạy lâu (LLM) NGOÀI transaction — giữ transaction thì còn bị `idle_in_transaction_session_timeout`
 *     cắt; (3) MỘT transaction ngắn: chuyển trạng thái CÓ KIỂM TOKEN (mất lease thì không ghi) rồi chèn
 *     phiên bản. Lỗi ở bất kỳ đâu → nhả lease rồi ném (vĩnh viễn: `PermanentReportError`).
 *
 * Vì sao lease thay cho `UPDATE … WHERE status = 'pending'` (bản thiết kế đầu, 06 §2): retry của BullMQ
 * sau lỗi tạm thấy `generating` do chính lần thử trước để lại → điều kiện không khớp → báo cáo kẹt mãi.
 */
@Injectable()
export class ReportGenerationService {
  private readonly logger = new Logger(ReportGenerationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ReportsRepository,
    @Inject(REPORT_WRITER) private readonly writer: ReportWriter,
    @Inject(REPORT_OPTIONS) private readonly options: ReportGenerationOptions,
    private readonly notifications: NotificationsService,
    private readonly fanout: NotificationFanoutService,
  ) {}

  async generate(job: ReportJob, run: { signal?: AbortSignal } = {}): Promise<ReportOutcome> {
    const report = await this.repo.claim(job.reportId, job.generation, this.options.leaseMs);
    if (!report) {
      this.logger.log(
        { ...job },
        'Bỏ qua: job cũ / trùng / báo cáo đã xong hoặc đang có người giữ',
      );
      return 'ignored';
    }
    try {
      return await this.run(report, job, run.signal);
    } catch (error) {
      await this.repo
        .release(report.id, report.generationToken)
        .catch((releaseError: unknown) =>
          this.logger.error({ err: releaseError, reportId: report.id }, 'Nhả lease lỗi'),
        );
      throw error;
    }
  }

  /** Hết lượt retry / lỗi vĩnh viễn → `failed`. `false` = job của lần tạo cũ, hoặc đã xong. */
  fail(job: ReportJob, message: string): Promise<boolean> {
    return this.repo.fail(job.reportId, job.generation, message);
  }

  private async run(
    report: ClaimedReport,
    job: ReportJob,
    signal: AbortSignal | undefined,
  ): Promise<ReportOutcome> {
    const meetings = await this.repo.meetingsForWeek(
      report.orgId,
      report.channelId,
      report.weekStart,
    );
    if (meetings.length < MIN_MEETINGS_FOR_REPORT) {
      const done = await this.db.transaction((tx) =>
        this.repo.completeSkipped(tx, report.id, report.generationToken),
      );
      return this.finish(done ? 'skipped' : 'ignored', report, job);
    }

    const { included, truncated } = selectMeetings(meetings, this.options.maxMeetings);
    // Việc quá hạn do SERVER lấy (không qua model), ngoài transaction như phần LLM.
    const overdue = selectOverdueItems(
      await this.repo.overdueActionItems(
        report.orgId,
        report.channelId,
        report.weekStart,
        MAX_OVERDUE_ACTION_ITEMS + 1,
      ),
    );
    const result = await this.writer
      .write(buildReportInput(report.channelName, report.weekStart, included), { signal })
      .catch((error: unknown) => {
        if (error instanceof LlmPermanentError) {
          throw new PermanentReportError('Không tạo được báo cáo.', { cause: error });
        }
        throw error;
      });

    const completed = await this.db.transaction(async (tx) => {
      const version = await this.repo.completeGenerated(tx, report, report.generationToken, {
        trigger: report.requestedTrigger,
        triggeredBy: report.requestedBy,
        // Danh sách meeting do SERVER ghép (id do model trả không đáng tin).
        content: {
          ...result.content,
          meetings: included.map((m) => ({
            id: m.id,
            title: m.title,
            recordedAt: m.recordedAt.toISOString(),
          })),
          overdueActionItems: overdue.items,
          overdueActionItemsTruncated: overdue.truncated,
        },
        meetingIds: included.map((m) => m.id),
        truncated,
        model: result.model,
        promptVersion: result.promptVersion,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      if (version === undefined) return undefined;
      // Tạo lại THỦ CÔNG (Q7): chỉ người bấm — MỘT người nhận nên ghi TRONG transaction như
      // `meeting.completed` (rollback thì không có thông báo "ma"). Bản theo lịch: cả kênh, fan-out dưới.
      const notifyUser =
        report.requestedTrigger === 'manual' && report.requestedBy
          ? (await this.repo.lockOrgMember(tx, report.orgId, report.requestedBy))
            ? report.requestedBy
            : null
          : null;
      const rows = notifyUser
        ? await this.notifications.recordInTx(tx, [
            {
              userId: notifyUser,
              orgId: report.orgId,
              type: 'report.ready',
              payload: {
                reportId: report.id,
                channelId: report.channelId,
                channelName: report.channelName,
                weekStart: report.weekStart,
                version,
              },
              dedupeKey: reportReadyKey(report.id, version),
            },
          ])
        : [];
      return { version, rows };
    });
    if (!completed) return this.finish('ignored', report, job);
    // SAU commit: đẩy realtime / xếp fan-out (đẩy trong transaction mà rollback → client thấy "ma").
    this.notifications.publish(completed.rows);
    if (report.requestedTrigger === 'scheduled') {
      await this.fanout.enqueueReportReady(report.id, completed.version, job.requestId);
    }
    return this.finish('completed', report, job);
  }

  private finish(outcome: ReportOutcome, report: ClaimedReport, job: ReportJob): ReportOutcome {
    if (outcome === 'ignored') {
      this.logger.warn({ reportId: report.id, requestId: job.requestId }, 'Mất lease — bỏ kết quả');
    }
    return outcome;
  }
}
