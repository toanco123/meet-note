import type { OrgRoleValue } from '../../infra/database/schema/index.js';
import type { OrgMembershipContext, TargetDecision } from './organizations.types.js';

/**
 * Quyền cấp tổ chức dưới dạng HÀM THUẦN — không DB, không HTTP. Guard và service cùng gọi;
 * unit test phủ toàn bộ ma trận. Nguồn sự thật: docs/design/04-authorization.md §1.
 */
export const OrgRole = { Owner: 'owner', Admin: 'admin', Member: 'member' } as const;
export type OrgRole = OrgRoleValue;

const RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };

export function isOrgRoleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return RANK[role] >= RANK[min];
}

/**
 * Tầng 1 — "vai trò này có được làm LOẠI hành động này không" (chưa biết đối tượng cụ thể).
 * `satisfies` kiểm tra mọi hàm đúng chữ ký mà vẫn giữ union key → `@Require('org.updte')` lỗi compile.
 */
export const orgPolicy = {
  'org.read': () => true,
  'org.update': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
  'org.delete': (ctx) => ctx.role === OrgRole.Owner,
  'org.member.list': () => true,
  'org.member.role.change': (ctx) => ctx.role === OrgRole.Owner,
  'org.member.remove': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
  // M3
  'org.invite.manage': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
  'org.join_request.manage': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
  'org.ownership.transfer': (ctx) => ctx.role === OrgRole.Owner,
  // Mọi thành viên gọi được; service trả 409 riêng cho Owner (phải chuyển quyền sở hữu trước),
  // thông điệp rõ hơn một 403 chung chung.
  'org.leave': () => true,
  'org.audit.read': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
  // M4 — kênh chưa tồn tại nên là quyền cấp org. Danh sách tự lọc theo quyền thấy (service).
  'org.channel.create': () => true,
  'org.channel.list': () => true,
  // M5 — mọi thành viên upload được; thao tác trên MỘT upload chỉ người tạo (service kiểm).
  'org.upload': () => true,
  // M5: chủ meeting xem được (service kiểm). M6 mở rộng theo quyền xem qua kênh (04 §3).
  'org.meeting.read': () => true,
  /** Share / gỡ share / sửa / xoá meeting (M6b): mọi thành viên gọi được, service kiểm theo đối tượng. */
  'org.meeting.manage': () => true,
  /** Dashboard tổ chức (M17): số liệu tổng hợp, chỉ Owner / Admin. Member → 403. */
  'org.dashboard.read': (ctx) => isOrgRoleAtLeast(ctx.role, OrgRole.Admin),
} satisfies Record<string, (ctx: OrgMembershipContext) => boolean>;

export type OrgPermission = keyof typeof orgPolicy;

/**
 * Tầng 2 — đổi vai trò của MỘT người cụ thể. Gọi trong service SAU khi khoá dòng.
 * Owner bất biến: muốn đổi thì chuyển quyền sở hữu (M3). Không ai được nâng người khác lên owner.
 */
export function canChangeRole(actor: OrgRole, target: OrgRole, newRole: OrgRole): TargetDecision {
  if (target === OrgRole.Owner) return 'owner_immutable';
  if (newRole === OrgRole.Owner) return 'forbidden';
  return actor === OrgRole.Owner ? 'ok' : 'forbidden';
}

/**
 * Tầng 2 — gỡ MỘT người cụ thể. "Không ai tác động lên người có vai trò ≥ mình, trừ Owner".
 * Không cần tham số "tự gỡ mình": Owner tự gỡ → rơi vào owner_immutable; Admin tự gỡ → target là
 * admin → forbidden (rời org là chức năng riêng ở M3).
 */
export function canRemoveMember(actor: OrgRole, target: OrgRole): TargetDecision {
  if (target === OrgRole.Owner) return 'owner_immutable';
  if (actor === OrgRole.Owner) return 'ok';
  if (actor === OrgRole.Admin && target === OrgRole.Member) return 'ok';
  return 'forbidden';
}

/**
 * Tầng 2 — cấp một vai trò cho người khác (tạo link mời, duyệt yêu cầu tham gia).
 * Không ai cấp được vai trò NGANG hoặc CAO HƠN mình, trừ Owner. Owner không bao giờ cấp qua đây.
 */
export function canGrantRole(actor: OrgRole, role: Exclude<OrgRole, 'owner'>): boolean {
  if (actor === OrgRole.Owner) return true;
  return actor === OrgRole.Admin && role === OrgRole.Member;
}
