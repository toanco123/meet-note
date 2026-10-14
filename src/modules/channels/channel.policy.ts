import type { ChannelRoleValue } from '../../infra/database/schema/index.js';
import { isOrgRoleAtLeast, OrgRole } from '../organizations/organization.policy.js';
import type { TargetDecision } from '../organizations/organizations.types.js';
import type {
  ChannelAccessContext,
  ChannelDecision,
  GrantableChannelRole,
} from './channels.types.js';

/**
 * Quyền cấp kênh — HÀM THUẦN. Nguồn sự thật: docs/design/04-authorization.md §2.
 * Người gọi được mô tả bằng (vai trò trong kênh | null, vai trò trong org, kênh công khai?).
 */
export const ChannelRole = {
  Owner: 'owner',
  Admin: 'admin',
  Member: 'member',
  Guest: 'guest',
} as const;
export type ChannelRole = ChannelRoleValue;

const RANK: Record<ChannelRole, number> = { owner: 4, admin: 3, member: 2, guest: 1 };

export function isChannelRoleAtLeast(role: ChannelRole | null, min: ChannelRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
}

const isChannelMember = (c: ChannelAccessContext) => c.channelRole !== null;
const isOrgAdmin = (c: ChannelAccessContext) => isOrgRoleAtLeast(c.orgRole, OrgRole.Admin);
const isPublic = (c: ChannelAccessContext) => c.channel.visibility === 'public';

export const channelPolicy = {
  /** Metadata kênh. Kênh riêng tư: OrgAdm thấy metadata dù không là thành viên. */
  'channel.read': (c) => isChannelMember(c) || isPublic(c) || isOrgAdmin(c),
  /** Nội dung (meeting, transcript, báo cáo — M6+). OrgAdm KHÔNG đọc nội dung kênh riêng tư (D2). */
  'channel.content.read': (c) => isChannelMember(c) || isPublic(c),
  /** Khách không xem được danh sách thành viên; người ngoài kênh công khai và OrgAdm thì được. */
  'channel.member.list': (c) =>
    isChannelMember(c) ? c.channelRole !== ChannelRole.Guest : isPublic(c) || isOrgAdmin(c),
  'channel.join': (c) => !isChannelMember(c) && isPublic(c),
  /** Mọi thành viên kênh; service trả 409 riêng cho Chủ kênh (phải chuyển chủ trước). */
  'channel.leave': (c) => isChannelMember(c),
  'channel.member.add': (c) => isChannelRoleAtLeast(c.channelRole, ChannelRole.Admin),
  'channel.member.role.change': (c) => isChannelRoleAtLeast(c.channelRole, ChannelRole.Admin),
  'channel.member.remove': (c) => isChannelRoleAtLeast(c.channelRole, ChannelRole.Admin),
  /** OrgAdm "override": chuyển hộ khi Chủ kênh cần rời org (M4 Q3). */
  'channel.ownership.transfer': (c) => c.channelRole === ChannelRole.Owner || isOrgAdmin(c),
  'channel.update': (c) => isChannelRoleAtLeast(c.channelRole, ChannelRole.Admin),
  'channel.archive': (c) => c.channelRole === ChannelRole.Owner || isOrgAdmin(c),
  'channel.delete': (c) => c.channelRole === ChannelRole.Owner || isOrgAdmin(c),
} satisfies Record<string, (ctx: ChannelAccessContext) => boolean>;

export type ChannelPermission = keyof typeof channelPolicy;

/**
 * Kênh lưu trữ = chỉ đọc: các permission này bị chặn (409 CHANNEL_ARCHIVED). Không có trong danh
 * sách: đọc, rời kênh, lưu trữ / bỏ lưu trữ, xoá.
 */
export const BLOCKED_WHEN_ARCHIVED: ReadonlySet<ChannelPermission> = new Set<ChannelPermission>([
  'channel.update',
  'channel.join',
  'channel.member.add',
  'channel.member.role.change',
  'channel.member.remove',
  'channel.ownership.transfer',
]);

/**
 * Một nơi quyết định 403 hay 409: guard gọi TRƯỚC khi khoá (từ chối nhanh), service gọi LẠI trên
 * dữ liệu vừa khoá (kênh có thể vừa bị lưu trữ, người gọi có thể vừa bị hạ quyền).
 * Xét quyền trước, trạng thái sau: người không có quyền luôn nhận 403, dù kênh lưu trữ hay không.
 */
export function decideChannelPermission(
  permission: ChannelPermission,
  ctx: ChannelAccessContext & { channel: { archivedAt: Date | null } },
): ChannelDecision {
  if (!channelPolicy[permission](ctx)) return 'forbidden';
  if (ctx.channel.archivedAt !== null && BLOCKED_WHEN_ARCHIVED.has(permission)) return 'archived';
  return 'ok';
}

/** CO cấp admin/member/guest; CA chỉ cấp member/guest ("không cấp vai trò ngang mình"). */
export function canGrantChannelRole(
  actor: ChannelRole | null,
  role: GrantableChannelRole,
): boolean {
  if (actor === ChannelRole.Owner) return true;
  return actor === ChannelRole.Admin && role !== ChannelRole.Admin;
}

const LOW_ROLES: ReadonlySet<ChannelRole> = new Set([ChannelRole.Member, ChannelRole.Guest]);

/** Đổi vai trò: CO đổi mọi người (trừ chủ); CA chỉ đổi qua lại member ↔ guest. */
export function canChangeChannelRole(
  actor: ChannelRole | null,
  target: ChannelRole,
  newRole: ChannelRole,
): TargetDecision {
  if (target === ChannelRole.Owner) return 'owner_immutable';
  if (newRole === ChannelRole.Owner) return 'forbidden';
  if (actor === ChannelRole.Owner) return 'ok';
  if (actor === ChannelRole.Admin && LOW_ROLES.has(target) && LOW_ROLES.has(newRole)) return 'ok';
  return 'forbidden';
}

/** Gỡ: CO gỡ mọi người (trừ chủ); CA chỉ gỡ member/guest. */
export function canRemoveChannelMember(
  actor: ChannelRole | null,
  target: ChannelRole,
): TargetDecision {
  if (target === ChannelRole.Owner) return 'owner_immutable';
  if (actor === ChannelRole.Owner) return 'ok';
  if (actor === ChannelRole.Admin && LOW_ROLES.has(target)) return 'ok';
  return 'forbidden';
}

/** Người nhận chủ kênh phải là thành viên kênh và KHÔNG phải Khách. */
export function canReceiveChannelOwnership(target: ChannelRole | null): boolean {
  return target !== null && target !== ChannelRole.Guest && target !== ChannelRole.Owner;
}
