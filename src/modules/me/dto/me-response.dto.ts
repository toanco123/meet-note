import { ApiProperty } from '@nestjs/swagger';
import {
  ORG_ROLES,
  type OrgRoleValue,
  type UserRow,
} from '../../../infra/database/schema/index.js';
import type { MyOrganizationRow } from '../../organizations/organizations.repository.js';

export class MeOrganizationDto {
  id: string;

  /** @example "Công ty TNHH Bình Minh" */
  name: string;

  @ApiProperty({ enum: ORG_ROLES, enumName: 'OrgRole' })
  role: OrgRoleValue;
}

export class MeResponseDto {
  id: string;

  /** @example "an.nguyen@example.com" */
  email: string;

  /** @example "Nguyễn Văn An" */
  displayName: string;

  /** @example "2026-10-13T08:00:00.000Z" */
  createdAt: string;

  /** Các tổ chức tôi là thành viên, theo thứ tự tham gia. */
  organizations: MeOrganizationDto[];

  /** Map tường minh từng field — KHÔNG spread row (row có passwordHash). */
  static from(row: UserRow, organizations: MyOrganizationRow[]): MeResponseDto {
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
      organizations: organizations.map((o) => ({ id: o.id, name: o.name, role: o.role })),
    };
  }
}
