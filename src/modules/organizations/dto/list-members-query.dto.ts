import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import { ORG_ROLES, type OrgRoleValue } from '../../../infra/database/schema/index.js';

export class ListMembersQueryDto extends CursorQueryDto {
  /**
   * Tìm theo tên hoặc email, không phân biệt hoa thường và dấu ("nguyen" khớp "Nguyễn").
   * Ký tự `%` và `_` được tìm nguyên văn.
   * @example "nguyen"
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  q?: string;

  /** Lọc theo vai trò. */
  @IsOptional()
  @IsIn(ORG_ROLES)
  @ApiProperty({ enum: ORG_ROLES, enumName: 'OrgRole', required: false })
  role?: OrgRoleValue;
}
