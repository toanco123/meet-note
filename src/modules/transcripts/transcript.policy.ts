import type { OrgRoleValue } from '../../infra/database/schema/index.js';
import { canManageMeeting } from '../meetings/meeting.policy.js';
import type { TranscriptEditDecision } from './transcripts.types.js';

/**
 * Ai sửa được transcript — hàm thuần. Cùng quyền với sửa / xoá meeting (`canManageMeeting`, M13 Q1):
 * chủ meeting, hoặc Owner / Admin org khi meeting không còn chủ. Quyền xét TRƯỚC, trạng thái SAU (như
 * `decideUnshare`): người không có quyền không biết meeting đang ở bước nào. Người gọi đã xem được
 * meeting (service kiểm trước), nên `forbidden` → 403, không lộ gì thêm.
 */
export function decideTranscriptEdit(
  meeting: { ownerId: string | null; status: string },
  viewer: { userId: string; orgRole: OrgRoleValue },
): TranscriptEditDecision {
  if (!canManageMeeting(meeting, viewer)) return 'forbidden';
  return meeting.status === 'completed' ? 'ok' : 'not_completed';
}
