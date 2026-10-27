import { Inject, Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectDateKey } from '../../../common/pagination/keys.js';
import type { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import { MAX_REGENERATE_COUNT } from '../../../infra/database/schema/index.js';
import type { ChannelAccess } from '../../channels/channels.types.js';
import {
  ReportResponseDto,
  ReportSummaryResponseDto,
  ReportVersionResponseDto,
} from '../dto/report-response.dto.js';
import { ReportScheduler } from '../report.scheduler.js';
import { ReportsRepository } from '../reports.repository.js';

/**
 * API báo cáo tuần (M9 B6). Quyền xem = quyền đọc nội dung kênh (`channel.content.read`, guard); tạo
 * lại = `channel.report.regenerate` (CO, CA). `access` do `ChannelAccessGuard` cấp.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ReportsRepository,
    private readonly scheduler: ReportScheduler,
  ) {}

  async list(
    access: ChannelAccess,
    query: CursorQueryDto,
  ): Promise<Page<ReportSummaryResponseDto>> {
    const after = query.cursor ? decodeCursor(query.cursor, 1) : undefined;
    const rows = await this.repo.listByChannel(
      access.orgId,
      access.channel.id,
      after && expectDateKey(after[0]),
      query.limit,
    );
    const page = toPage(rows, query.limit, (row) => [row.weekStart]);
    return {
      data: page.data.map((r) => ReportSummaryResponseDto.from(r)),
      nextCursor: page.nextCursor,
    };
  }

  /** Trạng thái + BẢN ĐANG HIỂN THỊ (kể cả khi đang tạo lại hoặc tạo lại lỗi: vẫn là bản cũ). */
  async get(access: ChannelAccess, weekStart: string): Promise<ReportResponseDto> {
    const report = await this.repo.findByWeek(access.orgId, access.channel.id, weekStart);
    if (!report) throw Errors.report.notFound();
    const version =
      report.currentVersion === null
        ? undefined
        : await this.repo.findVersion(access.orgId, report.id, report.currentVersion);
    return ReportResponseDto.detail(report, version);
  }

  /** Mọi phiên bản (≤ 4: bản theo lịch + 3 lần tạo lại), mới nhất trước — không phân trang. */
  async versions(access: ChannelAccess, weekStart: string): Promise<ReportVersionResponseDto[]> {
    const report = await this.repo.findByWeek(access.orgId, access.channel.id, weekStart);
    if (!report) throw Errors.report.notFound();
    const rows = await this.repo.versionsOf(access.orgId, report.id);
    return rows.map((r) => ReportVersionResponseDto.from(r));
  }

  /**
   * Tạo lại thủ công. Đọc-rồi-ghi quota nên PHẢI nguyên tử: transaction + `FOR UPDATE` dòng báo cáo,
   * kiểm lại trạng thái / quota SAU khi khoá, ghi, rồi mới (SAU commit) xếp job. Không khoá: hai cú bấm
   * cùng lúc đều đọc `count = 2` và cùng tăng — CHECK 0..3 chặn được nhưng người dùng nhận 500 thay vì 409.
   *
   * Không kiểm lại vai trò sau khi khoá (khác đổi quyền): hạ quyền chen giữa guard và đây chỉ cho thêm
   * MỘT lần tạo lại, bị quota 3 chặn, không lộ gì thêm.
   */
  async regenerate(
    access: ChannelAccess,
    weekStart: string,
    requestId: string | null,
  ): Promise<ReportResponseDto> {
    const updated = await this.db.transaction(async (tx) => {
      const report = await this.repo.lockByWeek(tx, access.orgId, access.channel.id, weekStart);
      if (!report) throw Errors.report.notFound();
      if (report.status === 'pending' || report.status === 'generating') {
        throw Errors.report.inProgress();
      }
      if (report.regenerateCount >= MAX_REGENERATE_COUNT) throw Errors.report.regenerateLimit();
      return this.repo.markRegenerating(tx, report.id, access.userId);
    });
    // SAU commit: worker chỉ thấy dòng `pending` đã commit. Enqueue lỗi (Redis sập) không làm hỏng
    // yêu cầu — dòng đã `pending`, job quét kẹt (B7) sẽ xếp lại.
    await this.scheduler
      .enqueueGenerate({ reportId: updated.id, generation: updated.regenerateCount, requestId })
      .catch((error: unknown) =>
        this.logger.error({ err: error, reportId: updated.id }, 'Enqueue tạo lại báo cáo lỗi'),
      );
    const current =
      updated.currentVersion === null
        ? undefined
        : await this.repo.findVersion(access.orgId, updated.id, updated.currentVersion);
    return ReportResponseDto.detail(updated, current);
  }
}
