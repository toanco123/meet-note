import { describe, expect, it } from 'vitest';
import type { SummaryActionItem } from '../../../../src/infra/llm/llm.types.js';
import {
  buildAiActionItems,
  MAX_AI_ACTION_ITEMS,
} from '../../../../src/modules/action-items/action-item-builder.js';

const item = (over: Partial<SummaryActionItem> = {}): SummaryActionItem => ({
  owner: null,
  task: 'Gửi báo giá',
  due: null,
  dueDate: null,
  ...over,
});
const MEMBERS = [{ userId: 'u-binh', displayName: 'Nguyễn Văn Bình' }];

describe('buildAiActionItems', () => {
  it('map đủ trường: người phụ trách đã khớp, hạn chữ + ngày', () => {
    const [out] = buildAiActionItems(
      [item({ owner: 'Bình', due: 'thứ sáu', dueDate: '2026-10-30' })],
      MEMBERS,
    );
    expect(out).toEqual({
      sourceIndex: 0,
      task: 'Gửi báo giá',
      ownerName: 'Bình',
      assigneeId: 'u-binh',
      dueText: 'thứ sáu',
      dueDate: '2026-10-30',
    });
  });

  it('người không khớp: giữ chữ gốc ở ownerName, assigneeId null', () => {
    const [out] = buildAiActionItems([item({ owner: 'Hoàng' })], MEMBERS);
    expect(out).toMatchObject({ ownerName: 'Hoàng', assigneeId: null });
  });

  it('sourceIndex là vị trí TRONG tóm tắt: bỏ việc rỗng thì các việc sau giữ nguyên vị trí', () => {
    const out = buildAiActionItems(
      [item({ task: 'a' }), item({ task: '   ' }), item({ task: 'c' })],
      MEMBERS,
    );
    expect(out.map((i) => [i.sourceIndex, i.task])).toEqual([
      [0, 'a'],
      [2, 'c'],
    ]);
  });

  it('chuỗi rỗng / toàn khoảng trắng ở owner, due → null (CHECK 1–200 không cho chuỗi rỗng)', () => {
    const [out] = buildAiActionItems([item({ owner: '  ', due: '' })], MEMBERS);
    expect(out).toMatchObject({ ownerName: null, dueText: null, assigneeId: null });
  });

  it('cắt theo KÝ TỰ, khớp CHECK: task 500, owner 200, due 200; không cắt đôi cặp thay thế', () => {
    const [out] = buildAiActionItems(
      [item({ task: '😀'.repeat(600), owner: 'x'.repeat(300), due: 'y'.repeat(300) })],
      MEMBERS,
    );
    expect(Array.from(out!.task)).toHaveLength(500);
    expect(Array.from(out!.ownerName!)).toHaveLength(200);
    expect(Array.from(out!.dueText!)).toHaveLength(200);
    expect(out!.task).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // không nửa cặp mồ côi
  });

  it('đúng 500 ký tự giữ nguyên', () => {
    const [out] = buildAiActionItems([item({ task: 'a'.repeat(500) })], MEMBERS);
    expect(out!.task).toHaveLength(500);
  });

  it(`tối đa ${MAX_AI_ACTION_ITEMS} việc; vị trí giữ nguyên`, () => {
    const many = Array.from({ length: MAX_AI_ACTION_ITEMS + 20 }, (_, i) =>
      item({ task: `v${i}` }),
    );
    const out = buildAiActionItems(many, MEMBERS);
    expect(out).toHaveLength(MAX_AI_ACTION_ITEMS);
    expect(out.at(-1)).toMatchObject({ sourceIndex: MAX_AI_ACTION_ITEMS - 1 });
  });

  it('tóm tắt cũ không có dueDate (undefined) → null', () => {
    const legacy = { owner: null, task: 't', due: null } as unknown as SummaryActionItem;
    expect(buildAiActionItems([legacy], MEMBERS)[0]?.dueDate).toBeNull();
  });

  it('danh sách rỗng → rỗng', () => {
    expect(buildAiActionItems([], MEMBERS)).toEqual([]);
  });
});
