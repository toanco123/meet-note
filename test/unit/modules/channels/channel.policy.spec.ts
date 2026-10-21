import { describe, expect, it } from 'vitest';
import {
  BLOCKED_WHEN_ARCHIVED,
  canChangeChannelRole,
  canGrantChannelRole,
  canReceiveChannelOwnership,
  canRemoveChannelMember,
  type ChannelPermission,
  channelPolicy,
  decideChannelPermission,
  type ChannelRole,
} from '../../../../src/modules/channels/channel.policy.js';
import type { ChannelAccessContext } from '../../../../src/modules/channels/channels.types.js';
import type { TargetDecision } from '../../../../src/modules/organizations/organizations.types.js';

/**
 * Bản "chạy được" của ma trận docs/design/04-authorization.md §2.
 * 6 kiểu người gọi × công khai/riêng tư. Đổi ma trận → đổi bảng này cùng lúc.
 */
type Actor = 'CO' | 'CA' | 'CM' | 'G' | 'OUT' | 'ORGADM';
const ACTORS: Record<Actor, Pick<ChannelAccessContext, 'channelRole' | 'orgRole'>> = {
  CO: { channelRole: 'owner', orgRole: 'member' },
  CA: { channelRole: 'admin', orgRole: 'member' },
  CM: { channelRole: 'member', orgRole: 'member' },
  G: { channelRole: 'guest', orgRole: 'member' },
  OUT: { channelRole: null, orgRole: 'member' }, // thành viên org chưa join kênh
  ORGADM: { channelRole: null, orgRole: 'admin' }, // org admin không phải thành viên kênh
};

// [permission, công khai: CO CA CM G OUT ORGADM, riêng tư: CO CA CM G OUT ORGADM]
const T = true;
const F = false;
const MATRIX: Array<[ChannelPermission, boolean[], boolean[]]> = [
  ['channel.read', [T, T, T, T, T, T], [T, T, T, T, F, T]],
  ['channel.content.read', [T, T, T, T, T, T], [T, T, T, T, F, F]],
  ['channel.member.list', [T, T, T, F, T, T], [T, T, T, F, F, T]],
  ['channel.join', [T, T, T, T, T, T], [T, T, T, T, F, F]],
  ['channel.leave', [T, T, T, T, F, F], [T, T, T, T, F, F]],
  ['channel.member.add', [T, T, F, F, F, F], [T, T, F, F, F, F]],
  ['channel.member.role.change', [T, T, F, F, F, F], [T, T, F, F, F, F]],
  ['channel.member.remove', [T, T, F, F, F, F], [T, T, F, F, F, F]],
  ['channel.ownership.transfer', [T, F, F, F, F, T], [T, F, F, F, F, T]],
  ['channel.update', [T, T, F, F, F, F], [T, T, F, F, F, F]],
  ['channel.archive', [T, F, F, F, F, T], [T, F, F, F, F, T]],
  ['channel.delete', [T, F, F, F, F, T], [T, F, F, F, F, T]],
  ['channel.meeting.share', [T, T, T, F, F, F], [T, T, T, F, F, F]],
];
const ORDER: Actor[] = ['CO', 'CA', 'CM', 'G', 'OUT', 'ORGADM'];

describe('channelPolicy — ma trận §2', () => {
  const cases = MATRIX.flatMap(([perm, pub, priv]) =>
    ORDER.flatMap((actor, i) => [
      [perm, actor, 'public', pub[i]] as const,
      [perm, actor, 'private', priv[i]] as const,
    ]),
  );

  it.each(cases)('%s × %s × %s → %s', (perm, actor, visibility, expected) => {
    expect(channelPolicy[perm]({ ...ACTORS[actor], channel: { visibility } })).toBe(expected);
  });

  it('bảng phủ đủ mọi permission của channelPolicy', () => {
    expect(MATRIX.map(([p]) => p).sort()).toEqual(Object.keys(channelPolicy).sort());
  });

  it('Org Owner (không phải thành viên kênh) có quyền như OrgAdm', () => {
    const ctx = {
      channelRole: null,
      orgRole: 'owner',
      channel: { visibility: 'private' },
    } as const;
    expect(channelPolicy['channel.delete'](ctx)).toBe(true);
    expect(channelPolicy['channel.content.read'](ctx)).toBe(false);
  });

  it('kênh lưu trữ chặn đúng các thao tác ghi, vẫn cho đọc / rời / bỏ lưu trữ / xoá', () => {
    expect([...BLOCKED_WHEN_ARCHIVED].sort()).toEqual([
      'channel.join',
      'channel.meeting.share',
      'channel.member.add',
      'channel.member.remove',
      'channel.member.role.change',
      'channel.ownership.transfer',
      'channel.update',
    ]);
  });
});

describe('canGrantChannelRole(actor, role)', () => {
  it.each<[ChannelRole | null, 'admin' | 'member' | 'guest', boolean]>([
    ['owner', 'admin', true],
    ['owner', 'guest', true],
    ['admin', 'admin', false],
    ['admin', 'member', true],
    ['admin', 'guest', true],
    ['member', 'guest', false],
    [null, 'member', false],
  ])('%s cấp %s → %s', (actor, role, expected) => {
    expect(canGrantChannelRole(actor, role)).toBe(expected);
  });
});

describe('canChangeChannelRole(actor, target, newRole)', () => {
  it.each<[ChannelRole | null, ChannelRole, ChannelRole, TargetDecision]>([
    ['owner', 'member', 'admin', 'ok'],
    ['owner', 'admin', 'guest', 'ok'],
    ['owner', 'member', 'owner', 'forbidden'], // chủ kênh chỉ đổi qua "chuyển chủ kênh"
    ['owner', 'owner', 'member', 'owner_immutable'],
    ['admin', 'member', 'guest', 'ok'],
    ['admin', 'guest', 'member', 'ok'],
    ['admin', 'member', 'admin', 'forbidden'], // CA không nâng ai lên ngang mình
    ['admin', 'admin', 'member', 'forbidden'], // CA không hạ CA khác
    ['member', 'guest', 'member', 'forbidden'],
    [null, 'member', 'guest', 'forbidden'], // OrgAdm không quản lý thành viên kênh
  ])('%s đổi %s → %s: %s', (actor, target, newRole, expected) => {
    expect(canChangeChannelRole(actor, target, newRole)).toBe(expected);
  });
});

describe('canRemoveChannelMember(actor, target)', () => {
  it.each<[ChannelRole | null, ChannelRole, TargetDecision]>([
    ['owner', 'admin', 'ok'],
    ['owner', 'guest', 'ok'],
    ['owner', 'owner', 'owner_immutable'],
    ['admin', 'member', 'ok'],
    ['admin', 'guest', 'ok'],
    ['admin', 'admin', 'forbidden'],
    ['member', 'guest', 'forbidden'],
    [null, 'member', 'forbidden'],
  ])('%s gỡ %s → %s', (actor, target, expected) => {
    expect(canRemoveChannelMember(actor, target)).toBe(expected);
  });
});

describe('canReceiveChannelOwnership(target)', () => {
  it.each<[ChannelRole | null, boolean]>([
    ['admin', true],
    ['member', true],
    ['guest', false],
    ['owner', false],
    [null, false],
  ])('%s → %s', (target, expected) => {
    expect(canReceiveChannelOwnership(target)).toBe(expected);
  });
});

describe('decideChannelPermission(permission, ctx)', () => {
  const at = (role: ChannelRole | null, archivedAt: Date | null) => ({
    channelRole: role,
    orgRole: 'member' as const,
    channel: { visibility: 'public' as const, archivedAt },
  });
  const archived = new Date();

  it.each([
    ['CA sửa kênh đang hoạt động', 'channel.update', at('admin', null), 'ok'],
    ['CA sửa kênh lưu trữ', 'channel.update', at('admin', archived), 'archived'],
    [
      'CM sửa kênh lưu trữ: xét quyền trước trạng thái',
      'channel.update',
      at('member', archived),
      'forbidden',
    ],
    ['CM đọc kênh lưu trữ', 'channel.read', at('member', archived), 'ok'],
    ['CM rời kênh lưu trữ', 'channel.leave', at('member', archived), 'ok'],
    ['CO lưu trữ / bỏ lưu trữ kênh lưu trữ', 'channel.archive', at('owner', archived), 'ok'],
  ] as const)('%s → %s', (_label, permission, ctx, expected) => {
    expect(decideChannelPermission(permission, ctx)).toBe(expected);
  });
});
