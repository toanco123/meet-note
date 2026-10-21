import { describe, expect, it } from 'vitest';
import { decideUnshare } from '../../../../src/modules/meetings/meeting-share.policy.js';
import type { UnshareContext } from '../../../../src/modules/meetings/meetings.types.js';

const base: UnshareContext = {
  channelRole: null,
  orgRole: 'member',
  channelArchived: false,
  isMeetingOwner: false,
  meetingOwnerless: false,
};

describe('decideUnshare — ai gỡ được meeting khỏi kênh (04 §2, M6b Q2 / Q4)', () => {
  it.each<[string, Partial<UnshareContext>, 'ok' | 'forbidden' | 'archived']>([
    ['chủ meeting, đã rời kênh (Q4)', { isMeetingOwner: true }, 'ok'],
    ['chủ meeting là khách trong kênh', { isMeetingOwner: true, channelRole: 'guest' }, 'ok'],
    ['Chủ kênh, meeting người khác', { channelRole: 'owner' }, 'ok'],
    ['QTV kênh, meeting người khác', { channelRole: 'admin' }, 'ok'],
    ['Thành viên kênh, meeting người khác', { channelRole: 'member' }, 'forbidden'],
    ['khách, meeting người khác', { channelRole: 'guest' }, 'forbidden'],
    ['Admin org, meeting CÓ chủ', { orgRole: 'admin' }, 'forbidden'],
    ['Admin org, meeting KHÔNG chủ (Q2)', { orgRole: 'admin', meetingOwnerless: true }, 'ok'],
    ['Owner org, meeting KHÔNG chủ (Q2)', { orgRole: 'owner', meetingOwnerless: true }, 'ok'],
    ['thành viên org, meeting không chủ', { meetingOwnerless: true }, 'forbidden'],
    [
      'kênh lưu trữ, người có quyền → 409',
      { channelRole: 'owner', channelArchived: true },
      'archived',
    ],
    // Xét quyền trước, trạng thái sau: không có quyền thì 403 dù kênh lưu trữ.
    ['kênh lưu trữ, người KHÔNG có quyền → 403', { channelArchived: true }, 'forbidden'],
  ])('%s → %s', (_label, over, expected) => {
    expect(decideUnshare({ ...base, ...over })).toBe(expected);
  });
});
