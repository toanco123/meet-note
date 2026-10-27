import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/database/database.types.js';
import type { SummaryActionItem } from '../../../infra/llm/llm.types.js';
import { buildAiActionItems } from '../action-item-builder.js';
import { ActionItemsRepository } from '../action-items.repository.js';

/**
 * Biến việc trong tóm tắt thành `action_items` (M12 B3). Gọi TRONG transaction của bước tóm tắt, sau
 * khi `completeSummarize` đã xác nhận còn giữ lease: tóm tắt, trạng thái `completed` và việc cùng
 * sống hoặc cùng chết — không có meeting `completed` mà thiếu việc, cũng không có việc mồ côi.
 *
 * Idempotent nhờ `insertAiIfAbsent` (`ON CONFLICT DO NOTHING`): bước tóm tắt chạy lại (lease hết hạn,
 * job lặp) không sinh trùng và không đè việc người đã sửa. Hệ quả có chủ đích: chạy lại KHÔNG thay
 * danh sách việc bằng bản tóm tắt mới.
 */
@Injectable()
export class ActionItemExtractionService {
  constructor(private readonly repo: ActionItemsRepository) {}

  /** Trả số việc THỰC SỰ chèn mới. */
  async extract(
    tx: DbExecutor,
    meeting: { id: string; orgId: string },
    items: readonly SummaryActionItem[],
  ): Promise<number> {
    if (items.length === 0) return 0;
    // Chỉ tải thành viên khi có ai đó được nêu tên — phần lớn việc là "không rõ ai".
    const needsMembers = items.some((i) => (i.owner?.trim() ?? '') !== '');
    const members = needsMembers ? await this.repo.listMemberNames(meeting.orgId, tx) : [];
    return this.repo.insertAiIfAbsent(meeting, buildAiActionItems(items, members), tx);
  }
}
