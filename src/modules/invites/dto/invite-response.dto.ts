import { ApiProperty } from '@nestjs/swagger';
import {
  INVITE_ROLES,
  type InviteRole,
  type OrganizationInviteRow,
} from '../../../infra/database/schema/index.js';

export const INVITE_STATUSES = ['active', 'expired', 'exhausted', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Trạng thái tính từ dữ liệu — không lưu cột riêng để khỏi lệch với `expires_at`/`use_count`. */
export function inviteStatus(row: OrganizationInviteRow, now = new Date()): InviteStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.maxUses !== null && row.useCount >= row.maxUses) return 'exhausted';
  return 'active';
}

/** Không bao giờ chứa token — DB chỉ có hash (M3 Q1). */
export class InviteResponseDto {
  id: string;

  @ApiProperty({ enum: INVITE_ROLES, enumName: 'InviteRole' })
  role: InviteRole;

  @ApiProperty({ enum: INVITE_STATUSES, enumName: 'InviteStatus' })
  status: InviteStatus;

  /** @example "2026-10-20T08:00:00.000Z" */
  expiresAt: string;

  /** `null` = không giới hạn. */
  @ApiProperty({ type: Number, nullable: true })
  maxUses: number | null;

  useCount: number;

  /** @example "2026-10-13T08:00:00.000Z" */
  createdAt: string;

  static from(row: OrganizationInviteRow): InviteResponseDto {
    return {
      id: row.id,
      role: row.role,
      status: inviteStatus(row),
      expiresAt: row.expiresAt.toISOString(),
      maxUses: row.maxUses,
      useCount: row.useCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export class CreatedInviteResponseDto extends InviteResponseDto {
  /**
   * Token của link mời — CHỈ trả một lần ở đây, không xem lại được. Link: `/invites/{token}`.
   * @example "q3Jt0b6Q2l3Zc0p9QpXb5m1q8D0yJ4dA7m2N5r1sT6w"
   */
  token: string;

  static withToken(row: OrganizationInviteRow, token: string): CreatedInviteResponseDto {
    return Object.assign(InviteResponseDto.from(row), { token });
  }
}
