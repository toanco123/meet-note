import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { INVITE_ROLES, type InviteRole } from '../../../infra/database/schema/index.js';

export const DEFAULT_INVITE_HOURS = 168;

export class CreateInviteDto {
  /** Vai trò người vào sẽ nhận. Link `admin` chỉ Owner tạo được. */
  @IsOptional()
  @IsIn(INVITE_ROLES)
  @ApiProperty({ enum: INVITE_ROLES, enumName: 'InviteRole', required: false, default: 'member' })
  role: InviteRole = 'member';

  /**
   * Link hết hạn sau bao nhiêu giờ (1–720, tức tối đa 30 ngày).
   * @default 168
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours: number = DEFAULT_INVITE_HOURS;

  /** Số lượt dùng tối đa (1–1000). Bỏ trống = không giới hạn. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxUses?: number;
}
