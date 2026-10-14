import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import {
  CHANNEL_VISIBILITIES,
  type ChannelVisibility,
} from '../../../infra/database/schema/index.js';

/**
 * Query string luôn là chuỗi, và dự án TẮT `enableImplicitConversion`. Chuyển tường minh, chỉ nhận
 * đúng "true"/"false". Bẫy: `Boolean("false") === true`.
 */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListChannelsQueryDto extends CursorQueryDto {
  /**
   * Tìm theo tên, không phân biệt hoa thường và dấu ("ky thuat" khớp "Kỹ thuật").
   * @example "ky thuat"
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 80)
  q?: string;

  @IsOptional()
  @IsIn(CHANNEL_VISIBILITIES)
  @ApiProperty({ enum: CHANNEL_VISIBILITIES, enumName: 'ChannelVisibility', required: false })
  visibility?: ChannelVisibility;

  /**
   * `true`: chỉ kênh đã lưu trữ. Mặc định chỉ kênh đang hoạt động.
   * @default false
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived: boolean = false;
}
