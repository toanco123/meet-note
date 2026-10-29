import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import {
  ACTION_ITEM_STATUSES,
  type ActionItemStatus,
} from '../../../infra/database/schema/index.js';

/** `?overdue=true|false` — query luôn là chuỗi, và `enableImplicitConversion` đang tắt. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListActionItemsQueryDto extends CursorQueryDto {
  /** `me`: chỉ việc được giao cho bạn ("việc của tôi"). Bỏ trống: mọi việc bạn xem được. */
  @IsOptional()
  @IsIn(['me'])
  @ApiProperty({ enum: ['me'], required: false })
  assignee?: 'me';

  /**
   * Trạng thái việc. Mặc định `open`.
   * @default "open"
   */
  @IsOptional()
  @IsIn(ACTION_ITEM_STATUSES)
  @ApiProperty({ enum: ACTION_ITEM_STATUSES, enumName: 'ActionItemStatus', required: false })
  status?: ActionItemStatus;

  /**
   * `true`: chỉ việc `open` đã quá hạn (hạn trước ngày hôm nay theo giờ Việt Nam). Kết hợp với
   * `status` khác `open` thì không có kết quả.
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;

  /** Chỉ việc của cuộc họp được chia sẻ vào kênh này. Phải đọc được nội dung kênh (không thì 403 / 404). */
  @IsOptional()
  @IsUUID()
  channelId?: string;
}
