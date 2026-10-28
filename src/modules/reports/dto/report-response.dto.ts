import { ApiProperty } from '@nestjs/swagger';
import {
  MAX_REGENERATE_COUNT,
  REPORT_STATUSES,
  REPORT_TRIGGERS,
  type ReportStatus,
  type ReportTrigger,
  type WeeklyReportRow,
  type WeeklyReportVersionRow,
} from '../../../infra/database/schema/index.js';

export class ReportActionItemDto {
  /** Người nhận việc nếu được nói rõ. */
  owner: string | null;

  task: string;

  /** Hạn như được nói (vd "thứ sáu"). */
  due: string | null;
}

export class ReportOverdueActionItemDto {
  id: string;

  /** @example "Gửi báo giá cho khách hàng" */
  task: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Người phụ trách: tên thành viên được giao, hoặc tên model nghe được. null = chưa ai.',
  })
  assignee: string | null;

  /** Hạn đã qua, `YYYY-MM-DD` (giờ VN). @example "2026-10-02" */
  dueDate: string;

  meetingId: string;

  meetingTitle: string;
}

export class ReportMeetingRefDto {
  id: string;

  title: string;

  /** @example "2026-10-07T03:00:00.000Z" */
  recordedAt: string;
}

/** Nội dung báo cáo của MỘT phiên bản. */
export class ReportContentDto {
  /** Tóm tắt cả tuần. */
  overview: string;

  /** Điểm nổi bật, gom theo chủ đề. */
  highlights: string[];

  /** Quyết định đã chốt. */
  decisions: string[];

  actionItems: ReportActionItemDto[];

  /** Các cuộc họp được tổng hợp (do hệ thống ghi, cũ nhất trước). */
  meetings: ReportMeetingRefDto[];

  /**
   * Việc còn mở đã quá hạn (hạn trước khi tuần này kết thúc) của các cuộc họp trong kênh, do hệ thống
   * ghép (không qua AI), hạn cũ nhất trước, tối đa 20. Báo cáo tạo trước M12 không có: trả `[]`.
   */
  overdueActionItems: ReportOverdueActionItemDto[];

  /** Còn việc quá hạn khác không hiện ở đây (vượt 20). */
  overdueActionItemsTruncated: boolean;
}

/** Phiên bản lưu trước M12 chưa có hai field việc quá hạn (jsonb không migrate) → mặc định rỗng. */
function withOverdueDefaults(content: Partial<ReportContentDto>): ReportContentDto {
  // `Object.assign` thay vì spread: DTO là class, spread bị lint chặn (mất prototype) dù ở đây content là jsonb thuần.
  return Object.assign({}, content, {
    overdueActionItems: content.overdueActionItems ?? [],
    overdueActionItemsTruncated: content.overdueActionItemsTruncated ?? false,
  }) as ReportContentDto;
}

export class ReportVersionResponseDto {
  version: number;

  @ApiProperty({ enum: REPORT_TRIGGERS, enumName: 'ReportTrigger' })
  trigger: ReportTrigger;

  /** Người bấm tạo lại; null với bản theo lịch hoặc khi người đó đã rời hệ thống. */
  triggeredBy: string | null;

  /** Đã bỏ bớt cuộc họp cũ hơn khi quá nhiều cuộc họp trong tuần. */
  truncated: boolean;

  /** Model THỰC SỰ viết báo cáo. */
  model: string;

  /** @example "2026-10-12T01:00:30.000Z" */
  createdAt: string;

  content: ReportContentDto;

  static from(row: WeeklyReportVersionRow): ReportVersionResponseDto {
    return {
      version: row.version,
      trigger: row.trigger,
      triggeredBy: row.triggeredBy,
      truncated: row.truncated,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
      // Đã validate khi ghi (`parseReportBody`) và do server ghép `meetings`.
      content: withOverdueDefaults(row.content as unknown as Partial<ReportContentDto>),
    };
  }
}

/** Một dòng của danh sách: không kèm nội dung. */
export class ReportSummaryResponseDto {
  /** Thứ Hai của tuần (giờ VN). @example "2026-10-05" */
  weekStart: string;

  @ApiProperty({ enum: REPORT_STATUSES, enumName: 'ReportStatus' })
  status: ReportStatus;

  /** Phiên bản đang hiển thị; null khi chưa có (đang tạo, bị bỏ qua, lỗi lần đầu). */
  currentVersion: number | null;

  /** Số lần đã tạo lại thủ công (tối đa 3). */
  regenerateCount: number;

  /** @example "2026-10-12T01:00:00.000Z" */
  createdAt: string;

  static from(row: WeeklyReportRow): ReportSummaryResponseDto {
    return {
      weekStart: row.weekStart,
      status: row.status,
      currentVersion: row.currentVersion,
      regenerateCount: row.regenerateCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** Chi tiết: trạng thái + bản đang hiển thị. */
export class ReportResponseDto extends ReportSummaryResponseDto {
  /** Còn mấy lần tạo lại thủ công. */
  regenerationsLeft: number;

  /** Lý do lỗi nếu `status = failed` (bản cũ nếu có vẫn ở `version`). */
  lastError: string | null;

  /** Phiên bản đang hiển thị; null khi chưa có. */
  version: ReportVersionResponseDto | null;

  static detail(
    row: WeeklyReportRow,
    version: WeeklyReportVersionRow | undefined,
  ): ReportResponseDto {
    return {
      weekStart: row.weekStart,
      status: row.status,
      currentVersion: row.currentVersion,
      regenerateCount: row.regenerateCount,
      createdAt: row.createdAt.toISOString(),
      regenerationsLeft: Math.max(0, MAX_REGENERATE_COUNT - row.regenerateCount),
      lastError: row.lastError,
      version: version ? ReportVersionResponseDto.from(version) : null,
    };
  }
}
