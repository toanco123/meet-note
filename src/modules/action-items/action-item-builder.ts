import type { SummaryActionItem } from '../../infra/llm/llm.types.js';
import { matchAssignee } from './assignee-matcher.js';
import type { NewAiActionItem, OrgMemberName } from './action-items.types.js';

/** Trần số việc lấy từ một bản tóm tắt: model lặp / bịa hàng trăm việc không được làm đầy bảng. */
export const MAX_AI_ACTION_ITEMS = 100;

// Khớp CHECK ở DB (`action_items_*_length_ck`); vượt thì CẮT, không để pipeline vỡ vì một chuỗi dài.
const MAX_TASK = 500;
const MAX_OWNER_NAME = 200;
const MAX_DUE_TEXT = 200;

/**
 * Cắt theo KÝ TỰ (code point) như `char_length` của Postgres. `slice` của JS đếm đơn vị UTF-16 nên có
 * thể cắt đôi cặp thay thế (emoji) → chuỗi không hợp lệ.
 */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

const clean = (value: string | null | undefined, max: number): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : clip(trimmed, max);
};

/**
 * Việc trong tóm tắt → bản ghi `action_items` (M12 B3). `sourceIndex` là vị trí TRONG tóm tắt (không
 * phải trong kết quả): bỏ một việc rỗng thì các việc sau giữ nguyên vị trí → khoá idempotency ổn định.
 * Việc không có nội dung thì bỏ; phần còn lại làm sạch cho khớp CHECK.
 */
export function buildAiActionItems(
  items: readonly SummaryActionItem[],
  members: readonly OrgMemberName[],
): NewAiActionItem[] {
  const result: NewAiActionItem[] = [];
  for (const [sourceIndex, item] of items.slice(0, MAX_AI_ACTION_ITEMS).entries()) {
    const task = clean(item.task, MAX_TASK);
    if (task === null) continue;
    const ownerName = clean(item.owner, MAX_OWNER_NAME);
    result.push({
      sourceIndex,
      task,
      ownerName,
      assigneeId: matchAssignee(ownerName, members),
      dueText: clean(item.due, MAX_DUE_TEXT),
      dueDate: item.dueDate ?? null,
    });
  }
  return result;
}
