import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { DashboardGranularity } from '../dashboard.types.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const GRANULARITIES = ['day', 'week'] as const;

/**
 * Ngày thật, khoảng tối đa và cửa sổ 92 ngày kiểm trong service (`resolveRange`) — class-validator ở đây
 * chỉ chặn chuỗi sai dạng; "2026-02-30" đi tiếp tới service và cũng ra 400.
 */
export class DashboardQueryDto {
  /**
   * Ngày bắt đầu (giờ Việt Nam), `YYYY-MM-DD`, gồm cả ngày này. Mặc định: 29 ngày trước `to`.
   * @example "2026-10-01"
   */
  @IsOptional()
  @Matches(DATE, { message: 'from phải có dạng YYYY-MM-DD.' })
  from?: string;

  /**
   * Ngày kết thúc (giờ Việt Nam), `YYYY-MM-DD`, gồm cả ngày này. Mặc định: hôm nay.
   * @example "2026-10-29"
   */
  @IsOptional()
  @Matches(DATE, { message: 'to phải có dạng YYYY-MM-DD.' })
  to?: string;

  /**
   * `day`: một điểm mỗi ngày. `week`: một điểm mỗi tuần (Thứ Hai → Chủ nhật, nhãn là Thứ Hai).
   * @default "day"
   */
  @IsOptional()
  @IsIn(GRANULARITIES)
  @ApiProperty({ enum: GRANULARITIES, enumName: 'DashboardGranularity', required: false })
  granularity?: DashboardGranularity;
}
