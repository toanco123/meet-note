import { ApiProperty } from '@nestjs/swagger';
import type { DashboardGranularity, DashboardOverview } from '../dashboard.types.js';

export class DashboardRangeDto {
  /** @example "2026-10-01" */
  from: string;

  /** @example "2026-10-29" */
  to: string;
}

/** Số cộng được của MỘT ngày (hoặc một tuần). */
export class DashboardPointDto {
  /** Ngày `YYYY-MM-DD`, hoặc Thứ Hai của tuần khi `granularity=week`. @example "2026-10-26" */
  period: string;

  /** Số cuộc họp ghi trong kỳ (chưa xoá). */
  meetings: number;

  /** Đã xử lý xong. */
  completed: number;

  /** Pipeline lỗi. */
  failed: number;

  /** Tổng thời lượng các cuộc họp đã biết thời lượng, làm tròn phút. */
  recordedMinutes: number;

  /** Tổng thời lượng các cuộc họp đã xử lý xong, làm tròn phút. */
  transcribedMinutes: number;
}

export class DashboardTotalsDto {
  meetings: number;

  completed: number;

  failed: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '`failed / (completed + failed)` trong 0..1. `null` = chưa có cuộc họp nào kết thúc (khác 0 là "có, không lỗi"). Cuộc họp đang xử lý không tính.',
    example: 0.0833,
  })
  failureRate: number | null;

  recordedMinutes: number;

  transcribedMinutes: number;
}

export class DashboardMembersDto {
  /** Tổng thành viên hiện tại. */
  total: number;

  /** Số chủ cuộc họp khác nhau có cuộc họp trong khoảng (chưa có lịch sử đăng nhập nên "hoạt động" = đã ghi một cuộc họp). */
  active: number;
}

export class DashboardStorageDto {
  /** Tổng dung lượng file gốc của các cuộc họp chưa xoá, tại thời điểm gọi (không đổi theo khoảng). */
  bytes: number;

  /** Số cuộc họp có file. */
  meetings: number;
}

export class DashboardTopChannelDto {
  channelId: string;

  /** @example "Kinh doanh" */
  name: string;

  /** Số cuộc họp chia sẻ vào kênh trong khoảng. */
  meetings: number;
}

export class DashboardActionItemsDto {
  /** Việc đang mở (thời điểm gọi). */
  open: number;

  /** Đang mở và hạn trước hôm nay (giờ VN); hạn đúng hôm nay chưa quá hạn. */
  overdue: number;

  /** Việc hoàn thành trong khoảng. */
  doneInRange: number;
}

/**
 * Dashboard tổ chức: CHỈ số tổng hợp — không tiêu đề cuộc họp, không nội dung, không tên người (D2).
 * Chuỗi theo ngày đến từ bảng rollup (trễ tối đa ~5 phút, xem `computedAt`); các khối còn lại tính lúc gọi.
 */
export class DashboardResponseDto {
  range: DashboardRangeDto;

  @ApiProperty({ enum: ['day', 'week'], enumName: 'DashboardGranularity' })
  granularity: DashboardGranularity;

  totals: DashboardTotalsDto;

  /** Điền đủ mọi kỳ trong khoảng (kỳ không có cuộc họp là 0), tăng dần. */
  @ApiProperty({ type: [DashboardPointDto] })
  series: DashboardPointDto[];

  members: DashboardMembersDto;

  storage: DashboardStorageDto;

  /** Tối đa 5 kênh nhiều cuộc họp nhất trong khoảng (kể cả kênh riêng tư — Owner / Admin đã thấy mọi kênh). */
  @ApiProperty({ type: [DashboardTopChannelDto] })
  topChannels: DashboardTopChannelDto[];

  actionItems: DashboardActionItemsDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Lần tính rollup gần nhất của các ngày trong khoảng. `null` = chưa ngày nào được tính (số theo ngày là 0 vì chưa tính).',
    example: '2026-10-29T05:00:12.000Z',
  })
  computedAt: string | null;

  static from(overview: DashboardOverview): DashboardResponseDto {
    return {
      range: { from: overview.range.from, to: overview.range.to },
      granularity: overview.granularity,
      totals: { ...overview.totals },
      series: overview.series.map((p) => ({ ...p })),
      members: { ...overview.members },
      storage: { ...overview.storage },
      topChannels: overview.topChannels.map((c) => ({
        channelId: c.channelId,
        name: c.name,
        meetings: c.meetings,
      })),
      actionItems: { ...overview.actionItems },
      computedAt: overview.computedAt,
    };
  }
}
