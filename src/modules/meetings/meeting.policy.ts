import type { ChannelDecision } from '../channels/channels.types.js';
import { ChannelRole, isChannelRoleAtLeast } from '../channels/channel.policy.js';
import { isOrgRoleAtLeast, OrgRole } from '../organizations/organization.policy.js';
import type { OrgRoleValue } from '../../infra/database/schema/index.js';
import type { UnshareContext } from './meetings.types.js';

/**
 * Ai gỡ được meeting khỏi kênh — kiểm theo ĐỐI TƯỢNG (cần biết meeting của ai), hàm thuần.
 * - chủ meeting: luôn được, kể cả khi đã rời kênh (dữ liệu của mình — M6b Q4);
 * - CO, CA: mọi meeting trong kênh;
 * - meeting không chủ: Owner / Admin org quản lý (M6b Q2);
 * - còn lại (CM với meeting người khác, khách, người ngoài) → 403.
 * Xét quyền trước, trạng thái sau (như `decideChannelPermission`): kênh lưu trữ → 409 cho người CÓ quyền.
 */
export function decideUnshare(c: UnshareContext): ChannelDecision {
  const allowed =
    c.isMeetingOwner ||
    isChannelRoleAtLeast(c.channelRole, ChannelRole.Admin) ||
    (c.meetingOwnerless && isOrgRoleAtLeast(c.orgRole, OrgRole.Admin));
  if (!allowed) return 'forbidden';
  if (c.channelArchived) return 'archived';
  return 'ok';
}

/**
 * Ai sửa / xoá được meeting: chủ meeting; meeting KHÔNG CHỦ (chủ rời org, D16) thì Owner / Admin org
 * quản lý (M6b Q2). OrgAdm không đụng được meeting CÓ chủ — kể cả meeting họ xem được.
 */
export function canManageMeeting(
  meeting: { ownerId: string | null },
  viewer: { userId: string; orgRole: OrgRoleValue },
): boolean {
  if (meeting.ownerId !== null) return meeting.ownerId === viewer.userId;
  return isOrgRoleAtLeast(viewer.orgRole, OrgRole.Admin);
}
