import { describe, expect, it } from 'vitest';
import {
  canChangeRole,
  canGrantRole,
  canRemoveMember,
  isOrgRoleAtLeast,
  type OrgPermission,
  orgPolicy,
  type OrgRole,
} from '../../../../src/modules/organizations/organization.policy.js';
import type { TargetDecision } from '../../../../src/modules/organizations/organizations.types.js';

/**
 * Các bảng dưới đây là bản "chạy được" của ma trận trong docs/design/04-authorization.md §1.
 * Đổi ma trận → đổi bảng này cùng lúc.
 */
const ctx = (role: OrgRole) => ({ orgId: 'org-1', role });

describe('orgPolicy — loại hành động theo vai trò', () => {
  const matrix: Array<[OrgPermission, owner: boolean, admin: boolean, member: boolean]> = [
    ['org.read', true, true, true],
    ['org.update', true, true, false],
    ['org.member.list', true, true, true],
    ['org.member.role.change', true, false, false],
    ['org.member.remove', true, true, false],
    ['org.invite.manage', true, true, false],
    ['org.join_request.manage', true, true, false],
    ['org.ownership.transfer', true, false, false],
    ['org.leave', true, true, true],
    ['org.audit.read', true, true, false],
    ['org.channel.create', true, true, true],
    ['org.channel.list', true, true, true],
  ];

  it.each(
    matrix.flatMap(([perm, o, a, m]) => [
      [perm, 'owner', o] as const,
      [perm, 'admin', a] as const,
      [perm, 'member', m] as const,
    ]),
  )('%s × %s → %s', (perm, role, expected) => {
    expect(orgPolicy[perm](ctx(role))).toBe(expected);
  });

  it('ma trận trong test phủ đủ mọi permission của orgPolicy', () => {
    expect(matrix.map(([perm]) => perm).sort()).toEqual(Object.keys(orgPolicy).sort());
  });
});

describe('isOrgRoleAtLeast', () => {
  it.each([
    ['owner', 'admin', true],
    ['admin', 'admin', true],
    ['member', 'admin', false],
    ['member', 'member', true],
  ] as const)('%s ≥ %s → %s', (role, min, expected) => {
    expect(isOrgRoleAtLeast(role, min)).toBe(expected);
  });
});

describe('canChangeRole(actor, target, newRole)', () => {
  it.each<[OrgRole, OrgRole, OrgRole, TargetDecision]>([
    // Owner đổi qua lại member ↔ admin
    ['owner', 'member', 'admin', 'ok'],
    ['owner', 'admin', 'member', 'ok'],
    ['owner', 'member', 'member', 'ok'], // không đổi gì — idempotent, vẫn hợp lệ
    // Không ai nâng người khác lên owner (phải chuyển quyền sở hữu)
    ['owner', 'admin', 'owner', 'forbidden'],
    // Owner bất biến — kể cả Owner tự đổi mình
    ['owner', 'owner', 'member', 'owner_immutable'],
    ['admin', 'owner', 'member', 'owner_immutable'],
    // Admin/Member không đổi vai trò được ai
    ['admin', 'member', 'admin', 'forbidden'],
    ['admin', 'admin', 'member', 'forbidden'],
    ['member', 'member', 'admin', 'forbidden'],
  ])('%s đổi %s → %s: %s', (actor, target, newRole, expected) => {
    expect(canChangeRole(actor, target, newRole)).toBe(expected);
  });
});

describe('canRemoveMember(actor, target)', () => {
  it.each<[OrgRole, OrgRole, TargetDecision]>([
    ['owner', 'admin', 'ok'],
    ['owner', 'member', 'ok'],
    ['owner', 'owner', 'owner_immutable'], // Owner tự gỡ mình
    ['admin', 'member', 'ok'],
    ['admin', 'admin', 'forbidden'], // kể cả Admin tự gỡ mình → dùng "rời org" (M3)
    ['admin', 'owner', 'owner_immutable'],
    ['member', 'member', 'forbidden'],
    ['member', 'admin', 'forbidden'],
    ['member', 'owner', 'owner_immutable'],
  ])('%s gỡ %s → %s', (actor, target, expected) => {
    expect(canRemoveMember(actor, target)).toBe(expected);
  });
});

describe('canGrantRole(actor, role) — tạo link mời / duyệt yêu cầu', () => {
  it.each<[OrgRole, 'admin' | 'member', boolean]>([
    ['owner', 'admin', true],
    ['owner', 'member', true],
    ['admin', 'admin', false], // không cấp vai trò ngang mình
    ['admin', 'member', true],
    ['member', 'member', false],
    ['member', 'admin', false],
  ])('%s cấp %s → %s', (actor, role, expected) => {
    expect(canGrantRole(actor, role)).toBe(expected);
  });
});
