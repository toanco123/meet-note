import { ApiProperty } from '@nestjs/swagger';
import { ORG_ROLES, type OrgRoleValue } from '../../../infra/database/schema/index.js';
import type { MyOrganizationRow, OrganizationDetailRow } from '../organizations.repository.js';

/** Một org trong danh sách "org của tôi". */
export class MyOrganizationResponseDto {
  id: string;

  /** @example "Công ty TNHH Bình Minh" */
  name: string;

  /** Vai trò của tôi trong org này. */
  @ApiProperty({ enum: ORG_ROLES, enumName: 'OrgRole' })
  role: OrgRoleValue;

  /** @example "2026-10-13T08:00:00.000Z" */
  joinedAt: string;

  static from(row: MyOrganizationRow): MyOrganizationResponseDto {
    return { id: row.id, name: row.name, role: row.role, joinedAt: row.joinedAt.toISOString() };
  }
}

export class OrganizationResponseDto {
  id: string;

  /** @example "Công ty TNHH Bình Minh" */
  name: string;

  /** @example "2026-10-13T08:00:00.000Z" */
  createdAt: string;

  /** Vai trò của người đang gọi. */
  @ApiProperty({ enum: ORG_ROLES, enumName: 'OrgRole' })
  myRole: OrgRoleValue;

  /** @example 12 */
  memberCount: number;

  static from(row: OrganizationDetailRow, myRole: OrgRoleValue): OrganizationResponseDto {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      myRole,
      memberCount: row.memberCount,
    };
  }
}
