import { ApiProperty } from '@nestjs/swagger';
import { ORG_ROLES, type OrgRoleValue } from '../../../infra/database/schema/index.js';
import type { MemberRow } from '../organization-members.repository.js';

export class MemberResponseDto {
  userId: string;

  /** @example "Nguyễn Văn An" */
  displayName: string;

  /** Hiển thị cho mọi thành viên cùng org (M2 Q3). @example "an.nguyen@example.com" */
  email: string;

  @ApiProperty({ enum: ORG_ROLES, enumName: 'OrgRole' })
  role: OrgRoleValue;

  /** @example "2026-10-13T08:00:00.000Z" */
  joinedAt: string;

  static from(row: MemberRow): MemberResponseDto {
    return {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
  }
}
