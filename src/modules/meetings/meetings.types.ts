import type { OrgRoleValue } from '../../infra/database/schema/index.js';

/** Người đang xem meeting: đủ để quyết định quyền xem (04 §3) mà không cần đọc thêm gì. */
export interface MeetingViewer {
  userId: string;
  /** Vai trò trong org trên path (OrgMemberGuard đã tải) — Owner / Admin quản lý meeting không chủ. */
  orgRole: OrgRoleValue;
}
