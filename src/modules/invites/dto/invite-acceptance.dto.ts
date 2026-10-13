import { ApiProperty } from '@nestjs/swagger';
import { INVITE_ROLES, type InviteRole } from '../../../infra/database/schema/index.js';

/** Xem trước link — công khai, chỉ thông tin cần để người nhận quyết định (M3 Q5). */
export class InvitePreviewResponseDto {
  /** @example "Công ty TNHH Bình Minh" */
  orgName: string;

  @ApiProperty({ enum: INVITE_ROLES, enumName: 'InviteRole' })
  role: InviteRole;

  /** @example "2026-10-20T08:00:00.000Z" */
  expiresAt: string;

  /** `true` → chấp nhận link chỉ tạo yêu cầu, chờ Owner/Admin duyệt. */
  requiresApproval: boolean;
}

export const ACCEPT_STATUSES = ['joined', 'pending'] as const;

export class AcceptInviteResponseDto {
  /** `joined`: đã vào tổ chức; `pending`: đã gửi yêu cầu, chờ duyệt. */
  @ApiProperty({ enum: ACCEPT_STATUSES, enumName: 'AcceptInviteStatus' })
  status: (typeof ACCEPT_STATUSES)[number];

  orgId: string;

  /** Chỉ có khi `status = pending`. */
  requestId?: string;
}
