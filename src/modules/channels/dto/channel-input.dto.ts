import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import {
  CHANNEL_VISIBILITIES,
  type ChannelVisibility,
} from '../../../infra/database/schema/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Chuỗi rỗng sau khi trim → `null` (= xoá mô tả). */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateChannelDto {
  /**
   * Tên kênh (1–80 ký tự), duy nhất trong tổ chức, không phân biệt hoa thường.
   * @example "Phòng Kỹ thuật"
   */
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name: string;

  /**
   * Mô tả ngắn (tối đa 500 ký tự).
   * @example "Giao ban kỹ thuật thứ Hai hằng tuần"
   */
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Mặc định `public`: mọi thành viên tổ chức thấy và tự tham gia được. */
  @IsOptional()
  @IsIn(CHANNEL_VISIBILITIES)
  @ApiProperty({ enum: CHANNEL_VISIBILITIES, enumName: 'ChannelVisibility', required: false })
  visibility?: ChannelVisibility;
}

/** Sửa một phần: chỉ field gửi lên mới được đổi. Body rỗng → không đổi gì (200). */
export class UpdateChannelDto {
  /** @example "Kỹ thuật – Backend" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name?: string;

  // Khai báo tay: `string | null` + optional, plugin chưa suy ra `nullable` chắc chắn.
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: 500,
    description: 'Mô tả mới. Gửi `null` hoặc chuỗi rỗng để xoá.',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsIn(CHANNEL_VISIBILITIES)
  @ApiProperty({ enum: CHANNEL_VISIBILITIES, enumName: 'ChannelVisibility', required: false })
  visibility?: ChannelVisibility;

  /** Bật/tắt báo cáo tuần của kênh (dùng từ M9). */
  @IsOptional()
  @IsBoolean()
  weeklyReportEnabled?: boolean;
}
