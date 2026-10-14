/** Kiểu viết tay của module mời / yêu cầu tham gia. */

import type {
  InviteRole,
  JoinRequestStatus,
  OrganizationInviteRow,
} from '../../infra/database/schema/index.js';

export type InviteListRow = OrganizationInviteRow & { createdAtKey: string };

export interface JoinRequestListRow {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  role: InviteRole;
  status: JoinRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  createdAtKey: string;
}
