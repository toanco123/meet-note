/**
 * Danh sách đóng các hành động được ghi — gõ sai là lỗi compile. Quy ước `domain.object.verb_past`.
 * Là GIÁ TRỊ runtime (validate query + enum Swagger) nên không nằm trong `audit.types.ts`;
 * `AuditAction` suy ra từ nó nên đứng ngay cạnh.
 */
export const AUDIT_ACTIONS = [
  'org.created',
  'org.updated',
  'org.member.role_changed',
  'org.member.removed',
  'org.member.joined',
  'org.member.left',
  'org.invite.created',
  'org.invite.revoked',
  'org.join_request.created',
  'org.join_request.approved',
  'org.join_request.rejected',
  'org.ownership.transferred',
  'org.deleted',
  'channel.created',
  'channel.updated',
  'channel.member.added',
  'channel.member.role_changed',
  'channel.member.removed',
  'channel.member.joined',
  'channel.member.left',
  'channel.ownership.transferred',
  'channel.archived',
  'channel.unarchived',
  'channel.deleted',
  'channel.purged',
  'meeting.deleted',
  /** OrgAdm chạy lại meeting không chủ (M6 B7). */
  'meeting.retried',
  /** Người KHÔNG phải chủ (OrgAdm, meeting không chủ) sửa một đoạn transcript (M13). */
  'transcript.segment.edited',
  /** Người KHÔNG phải chủ (OrgAdm, meeting không chủ) tạo việc cần làm thủ công (M12). */
  'action_item.created',
  /** Người KHÔNG phải chủ sửa nội dung / bỏ / khôi phục một việc cần làm (M12). Đổi mở ↔ xong thì không ghi. */
  'action_item.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
