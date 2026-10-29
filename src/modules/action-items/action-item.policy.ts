import type { ActionItemStatus, OrgRoleValue } from '../../infra/database/schema/index.js';
import { canManageMeeting } from '../meetings/meeting.policy.js';
import type { ActionItemPatch, ActionItemWriteDecision } from './action-items.types.js';

/** Hai trạng thái người được giao tự đổi qua lại; `dismissed` là của người quản lý meeting. */
const ASSIGNEE_STATUSES: readonly ActionItemStatus[] = ['open', 'done'];

/**
 * Sửa này có đụng phần CHỈ người quản lý meeting được làm không? Nội dung (`task`, `assigneeId`,
 * `dueDate`) — xét theo field CÓ MẶT, kể cả gửi lại đúng giá trị cũ (đơn giản và không lộ giá trị
 * hiện tại qua 403 / 200). Và mọi chuyển trạng thái có `dismissed` ở một đầu: bỏ việc, và khôi phục
 * việc đã bỏ (người được giao không "cứu" được việc người quản lý đã bỏ).
 */
export function requiresManager(
  item: { status: ActionItemStatus },
  patch: ActionItemPatch,
): boolean {
  if (patch.task !== undefined || patch.assigneeId !== undefined || patch.dueDate !== undefined) {
    return true;
  }
  if (patch.status === undefined) return false;
  return !(ASSIGNEE_STATUSES.includes(item.status) && ASSIGNEE_STATUSES.includes(patch.status));
}

/**
 * Ai sửa được việc — hàm thuần (M12 Q6). Người QUẢN LÝ meeting (`canManageMeeting`, như sửa
 * transcript M13): mọi thứ. Người ĐƯỢC GIAO: chỉ `open` ↔ `done`, trên việc của mình. Còn lại 403 —
 * người gọi đã xem được meeting (service kiểm trước nên 404 không bị lộ qua 403).
 */
export function decideActionItemWrite(
  item: { status: ActionItemStatus; assigneeId: string | null },
  patch: ActionItemPatch,
  meeting: { ownerId: string | null },
  viewer: { userId: string; orgRole: OrgRoleValue },
): ActionItemWriteDecision {
  if (canManageMeeting(meeting, viewer)) return 'ok';
  if (requiresManager(item, patch)) return 'forbidden';
  return item.assigneeId === viewer.userId ? 'ok' : 'forbidden';
}
