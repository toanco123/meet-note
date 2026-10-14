import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import { CHANNEL_ROLES, type ChannelRoleValue } from '../../../infra/database/schema/index.js';
import type { ChannelMemberRow } from '../channel-members.repository.js';
import type { GrantableChannelRole } from '../channel.policy.js';

/** Vai trò gán được qua API. `owner` không nằm ở đây: đổi chủ kênh = chuyển chủ kênh (B5). */
export const GRANTABLE_CHANNEL_ROLES = [
  'admin',
  'member',
  'guest',
] as const satisfies readonly GrantableChannelRole[];

export class AddChannelMemberDto {
  /** Người được thêm — phải là thành viên tổ chức (không phải → 404). */
  @IsUUID()
  userId: string;

  /** QTV kênh chỉ thêm được `member` / `guest`. */
  @IsIn(GRANTABLE_CHANNEL_ROLES)
  @ApiProperty({
    enum: GRANTABLE_CHANNEL_ROLES,
    enumName: 'GrantableChannelRole',
    example: 'member',
  })
  role: GrantableChannelRole;
}

export class UpdateChannelMemberRoleDto {
  @IsIn(GRANTABLE_CHANNEL_ROLES)
  @ApiProperty({
    enum: GRANTABLE_CHANNEL_ROLES,
    enumName: 'GrantableChannelRole',
    example: 'guest',
  })
  role: GrantableChannelRole;
}

export class ListChannelMembersQueryDto extends CursorQueryDto {
  /**
   * Tìm theo tên hoặc email, không phân biệt hoa thường và dấu.
   * @example "nguyen"
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  q?: string;

  @IsOptional()
  @IsIn(CHANNEL_ROLES)
  @ApiProperty({ enum: CHANNEL_ROLES, enumName: 'ChannelRole', required: false })
  role?: ChannelRoleValue;
}

export class ChannelMemberResponseDto {
  userId: string;

  /** @example "Nguyễn Văn An" */
  displayName: string;

  /** @example "an.nguyen@example.com" */
  email: string;

  @ApiProperty({ enum: CHANNEL_ROLES, enumName: 'ChannelRole' })
  role: ChannelRoleValue;

  /** @example "2026-10-14T08:00:00.000Z" */
  joinedAt: string;

  static from(row: ChannelMemberRow): ChannelMemberResponseDto {
    return {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
  }
}
