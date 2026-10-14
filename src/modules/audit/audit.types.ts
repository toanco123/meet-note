/** Kiểu viết tay của module audit. */

import type { AuditAction } from './audit-actions.js';

// ── Ghi audit ─────────────────────────────────────────────────────────────────

/** Ai / từ đâu — controller lấy bằng `@AuditCtx()` rồi truyền tường minh xuống service (M3 Q3). */
export interface AuditContext {
  /** NULL = hệ thống (job, script). */
  actorId: string | null;
  requestId?: string | null;
  ip?: string | null;
}

/** Thao tác do một người dùng đã đăng nhập thực hiện. */
export type UserAuditContext = AuditContext & { actorId: string };

export interface AuditEntry {
  orgId: string;
  action: AuditAction;
  targetType: 'organization' | 'member' | 'invite' | 'join_request' | 'channel';
  targetId: string;
  /** Thường là `{ before, after }` — chỉ những field thay đổi, KHÔNG ghi dữ liệu nhạy cảm. */
  metadata?: Record<string, unknown>;
}

// ── Đọc audit (repository → DTO) ──────────────────────────────────────────────

export interface AuditLogListRow {
  id: number;
  action: string;
  actorId: string | null;
  actorDisplayName: string | null;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
  ip: string | null;
  createdAt: Date;
  createdAtKey: string;
}
