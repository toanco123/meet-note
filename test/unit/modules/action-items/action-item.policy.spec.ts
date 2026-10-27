import { describe, expect, it } from 'vitest';
import type { ActionItemStatus } from '../../../../src/infra/database/schema/index.js';
import {
  decideActionItemWrite,
  requiresManager,
} from '../../../../src/modules/action-items/action-item.policy.js';
import type { ActionItemPatch } from '../../../../src/modules/action-items/action-items.types.js';

const MEETING_OWNER = 'u-owner';
const ASSIGNEE = 'u-assignee';
const OTHER = 'u-other';
const item = (status: ActionItemStatus, assigneeId: string | null = ASSIGNEE) => ({
  status,
  assigneeId,
});

describe('requiresManager — field / chuyển trạng thái nào là của người quản lý meeting', () => {
  it.each([
    ['task', { task: 'x' }, 'open', true],
    ['assigneeId', { assigneeId: 'u' }, 'open', true],
    ['assigneeId = null (bỏ giao)', { assigneeId: null }, 'open', true],
    ['dueDate', { dueDate: '2026-11-05' }, 'open', true],
    ['dueDate = null (bỏ hạn)', { dueDate: null }, 'open', true],
    ['gửi lại đúng giá trị cũ vẫn tính là sửa nội dung', { task: 'Việc mẫu' }, 'open', true],
    ['open → done', { status: 'done' }, 'open', false],
    ['done → open', { status: 'open' }, 'done', false],
    ['open → open (không đổi)', { status: 'open' }, 'open', false],
    ['done → done (đặt lại)', { status: 'done' }, 'done', false],
    ['open → dismissed (bỏ việc)', { status: 'dismissed' }, 'open', true],
    ['done → dismissed', { status: 'dismissed' }, 'done', true],
    ['dismissed → open (khôi phục)', { status: 'open' }, 'dismissed', true],
    ['dismissed → done', { status: 'done' }, 'dismissed', true],
    ['dismissed → dismissed', { status: 'dismissed' }, 'dismissed', true],
    ['trạng thái + nội dung', { status: 'done', task: 'x' }, 'open', true],
  ] as [string, ActionItemPatch, ActionItemStatus, boolean][])(
    '%s → %s',
    (_label, patch, current, expected) => {
      expect(requiresManager({ status: current }, patch)).toBe(expected);
    },
  );
});

describe('decideActionItemWrite (M12 Q6) — ai được ghi', () => {
  const owned = { ownerId: MEETING_OWNER };
  const ownerless = { ownerId: null };

  it.each([
    ['chủ meeting', MEETING_OWNER, 'member'],
    ['chủ meeting cũng là Admin org', MEETING_OWNER, 'admin'],
  ] as const)(
    '%s: mọi thứ, kể cả việc đã bỏ và việc không phải của mình',
    (_l, userId, orgRole) => {
      for (const status of ['open', 'done', 'dismissed'] as const) {
        for (const patch of [
          { task: 'x' },
          { status: 'dismissed' },
          { status: 'open' },
          { assigneeId: null },
        ] as ActionItemPatch[]) {
          expect(
            decideActionItemWrite(item(status, OTHER), patch, owned, { userId, orgRole }),
          ).toBe('ok');
        }
      }
    },
  );

  it.each([
    ['open → done', 'open', { status: 'done' }, 'ok'],
    ['done → open', 'done', { status: 'open' }, 'ok'],
    ['bỏ việc', 'open', { status: 'dismissed' }, 'forbidden'],
    ['khôi phục việc đã bỏ', 'dismissed', { status: 'open' }, 'forbidden'],
    ['đóng việc đã bỏ', 'dismissed', { status: 'done' }, 'forbidden'],
    ['sửa nội dung', 'open', { task: 'x' }, 'forbidden'],
    ['bỏ giao', 'open', { assigneeId: null }, 'forbidden'],
    ['đổi hạn', 'open', { dueDate: '2026-11-05' }, 'forbidden'],
    ['trộn trạng thái với nội dung', 'open', { status: 'done', task: 'x' }, 'forbidden'],
  ] as [string, ActionItemStatus, ActionItemPatch, string][])(
    'người được giao, meeting người khác: %s → %s',
    (_l, current, patch, expected) => {
      expect(
        decideActionItemWrite(item(current), patch, owned, { userId: ASSIGNEE, orgRole: 'member' }),
      ).toBe(expected);
    },
  );

  it.each([
    ['member khác', 'member'],
    ['Admin org (meeting CÓ chủ)', 'admin'],
    ['Owner org (meeting CÓ chủ)', 'owner'],
  ] as const)('%s không phải người được giao: không ghi được gì', (_l, orgRole) => {
    for (const patch of [{ status: 'done' }, { task: 'x' }] as ActionItemPatch[]) {
      expect(decideActionItemWrite(item('open'), patch, owned, { userId: OTHER, orgRole })).toBe(
        'forbidden',
      );
    }
  });

  it('việc CHƯA giao cho ai: không ai ngoài người quản lý đổi được trạng thái', () => {
    expect(
      decideActionItemWrite(item('open', null), { status: 'done' }, owned, {
        userId: OTHER,
        orgRole: 'member',
      }),
    ).toBe('forbidden');
  });

  it.each([
    ['Admin org', 'admin', 'ok'],
    ['Owner org', 'owner', 'ok'],
    ['member', 'member', 'forbidden'],
  ] as const)('meeting KHÔNG chủ: %s sửa nội dung → %s', (_l, orgRole, expected) => {
    expect(
      decideActionItemWrite(item('open', null), { task: 'x' }, ownerless, {
        userId: OTHER,
        orgRole,
      }),
    ).toBe(expected);
  });

  it('meeting không chủ, member LÀ người được giao: đổi được trạng thái, không sửa được nội dung', () => {
    const viewer = { userId: ASSIGNEE, orgRole: 'member' } as const;
    expect(decideActionItemWrite(item('open'), { status: 'done' }, ownerless, viewer)).toBe('ok');
    expect(decideActionItemWrite(item('open'), { task: 'x' }, ownerless, viewer)).toBe('forbidden');
  });
});
