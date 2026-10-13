/** Ai / từ đâu — controller lấy bằng `@AuditCtx()` rồi truyền tường minh xuống service (M3 Q3). */
/** Thao tác do một người dùng đã đăng nhập thực hiện. */
export type UserAuditContext = AuditContext & { actorId: string };

export interface AuditContext {
  /** NULL = hệ thống (job, script). */
  actorId: string | null;
  requestId?: string | null;
  ip?: string | null;
}

/** Danh sách đóng các hành động được ghi — gõ sai là lỗi compile. Quy ước `domain.object.verb_past`. */
export type AuditAction =
  | 'org.created'
  | 'org.updated'
  | 'org.member.role_changed'
  | 'org.member.removed'
  | 'org.member.joined'
  | 'org.member.left'
  | 'org.invite.created'
  | 'org.invite.revoked'
  | 'org.join_request.created'
  | 'org.join_request.approved'
  | 'org.join_request.rejected'
  | 'org.ownership.transferred';

export interface AuditEntry {
  orgId: string;
  action: AuditAction;
  targetType: 'organization' | 'member' | 'invite' | 'join_request';
  targetId: string;
  /** Thường là `{ before, after }` — chỉ những field thay đổi, KHÔNG ghi dữ liệu nhạy cảm. */
  metadata?: Record<string, unknown>;
}
