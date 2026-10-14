import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import {
  INVITE_ROLES,
  type InviteRole,
  JOIN_REQUEST_STATUSES,
  type JoinRequestStatus,
} from '../../../infra/database/schema/index.js';
import type { JoinRequestListRow } from '../invites.types.js';

export class ListJoinRequestsQueryDto extends CursorQueryDto {
  /** @default "pending" */
  @IsOptional()
  @IsIn(JOIN_REQUEST_STATUSES)
  @ApiProperty({ enum: JOIN_REQUEST_STATUSES, enumName: 'JoinRequestStatus', required: false })
  status: JoinRequestStatus = 'pending';
}

export class JoinRequestResponseDto {
  id: string;

  userId: string;

  /** @example "Nguyễn Văn An" */
  displayName: string;

  /** @example "an.nguyen@example.com" */
  email: string;

  @ApiProperty({ enum: INVITE_ROLES, enumName: 'InviteRole' })
  role: InviteRole;

  @ApiProperty({ enum: JOIN_REQUEST_STATUSES, enumName: 'JoinRequestStatus' })
  status: JoinRequestStatus;

  createdAt: string;

  @ApiProperty({ type: String, nullable: true })
  decidedAt: string | null;

  static from(row: Omit<JoinRequestListRow, 'createdAtKey'>): JoinRequestResponseDto {
    return {
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }
}

export class JoinRequestDecisionResponseDto {
  id: string;

  @ApiProperty({ enum: ['approved', 'rejected'], enumName: 'JoinRequestDecision' })
  status: 'approved' | 'rejected';
}
