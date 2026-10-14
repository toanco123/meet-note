/** Kiểu viết tay của module tổ chức. */

import type { OrgRoleValue } from '../../infra/database/schema/index.js';

// ── Policy + guard ────────────────────────────────────────────────────────────

/** Do `OrgMemberGuard` gắn vào `req.orgMembership`. */
export interface OrgMembershipContext {
  orgId: string;
  role: OrgRoleValue;
}

/** Kết quả kiểm tra theo đối tượng — service đổi thành mã lỗi HTTP. */
export type TargetDecision = 'ok' | 'forbidden' | 'owner_immutable';

// Declaration merging: `req.orgMembership` có kiểu ở mọi nơi (do OrgMemberGuard gắn).
declare global {
  // oxlint-disable-next-line typescript/no-namespace -- cú pháp bắt buộc để mở rộng namespace Express
  namespace Express {
    interface Request {
      orgMembership?: OrgMembershipContext;
    }
  }
}

// ── Repository ────────────────────────────────────────────────────────────────

export interface MyOrganizationRow {
  id: string;
  name: string;
  role: OrgRoleValue;
  joinedAt: Date;
}

/** Các field sửa được qua `PATCH /orgs/:orgId`. */
export interface OrganizationPatch {
  name?: string;
  requireJoinApproval?: boolean;
}

export interface OrganizationDetailRow {
  id: string;
  name: string;
  requireJoinApproval: boolean;
  createdAt: Date;
  memberCount: number;
}

export interface MemberRow {
  userId: string;
  displayName: string;
  email: string;
  role: OrgRoleValue;
  joinedAt: Date;
  /** Khoá cursor (ISO micro giây do DB sinh) — không dùng `joinedAt` (Date, chỉ mili giây). */
  joinedAtKey: string;
}

export interface ListMembersParams {
  orgId: string;
  q?: string;
  role?: OrgRoleValue;
  /** [joinedAtKey, userId] của dòng cuối trang trước. */
  after?: [string, string];
  limit: number;
}
