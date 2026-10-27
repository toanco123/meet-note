import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  type ActionItemRow,
  actionItems,
  organizationMembers,
  users,
} from '../../infra/database/schema/index.js';
import type {
  ActionItemPatch,
  NewAiActionItem,
  OrgMemberName,
  UpdateActionItemOutcome,
} from './action-items.types.js';

/** Truy vấn `action_items` (M12). Mọi hàm nhận `executor` tuỳ chọn để chạy trong transaction của service. */
@Injectable()
export class ActionItemsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Chèn việc AI của một meeting, BỎ QUA những vị trí đã có (`ON CONFLICT DO NOTHING` trên
   * `action_items_ai_source_uq`). Đây là chốt idempotency của pipeline (Q3): chạy lại bước tóm tắt
   * không sinh trùng, và vì không có UPDATE nào nên không đè việc đã sửa / đã `done` / đã `dismissed`.
   * Trả số dòng THỰC SỰ chèn.
   */
  async insertAiIfAbsent(
    meeting: { id: string; orgId: string },
    items: NewAiActionItem[],
    executor: DbExecutor = this.db,
  ): Promise<number> {
    if (items.length === 0) return 0;
    const rows = await executor
      .insert(actionItems)
      .values(
        items.map((i) => ({
          orgId: meeting.orgId,
          meetingId: meeting.id,
          origin: 'ai' as const,
          sourceIndex: i.sourceIndex,
          task: i.task,
          ownerName: i.ownerName,
          assigneeId: i.assigneeId,
          dueText: i.dueText,
          dueDate: i.dueDate,
        })),
      )
      // Index một phần: `ON CONFLICT` phải nêu lại đúng điều kiện `WHERE` của nó để Postgres suy ra
      // index nào là đích; thiếu `where` → "no unique constraint matching the ON CONFLICT".
      .onConflictDoNothing({
        target: [actionItems.meetingId, actionItems.sourceIndex],
        where: sql`${actionItems.origin} = 'ai'`,
      })
      .returning({ id: actionItems.id });
    return rows.length;
  }

  /**
   * Tên hiển thị của MỌI thành viên org — ứng viên để map "Bình" → người. Chỉ gọi khi có việc nêu
   * người phụ trách. Org cỡ hàng trăm người thì rẻ; org rất lớn sẽ cần tìm theo `search_text` thay vì
   * tải hết (ghi ở plan M12).
   */
  listMemberNames(orgId: string, executor: DbExecutor = this.db): Promise<OrgMemberName[]> {
    return executor
      .select({ userId: organizationMembers.userId, displayName: users.displayName })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(asc(organizationMembers.userId));
  }

  /** Việc của một meeting theo thứ tự tạo (`id` là uuidv7: tăng theo thời gian). */
  listByMeeting(meetingId: string, executor: DbExecutor = this.db): Promise<ActionItemRow[]> {
    return executor
      .select()
      .from(actionItems)
      .where(eq(actionItems.meetingId, meetingId))
      .orderBy(asc(actionItems.id));
  }

  /**
   * Sửa bằng khoá lạc quan (M13 Q3): MỘT câu `UPDATE … WHERE version = $expected`; 0 dòng thì đọc thêm
   * một lần để phân biệt "không còn" với "version lệch".
   *
   * Hệ quả theo trạng thái nằm ở ĐÂY (không để service nhớ): sang `done` → đặt `completed_at/by`;
   * rời `done` → xoá cả hai (CHECK `action_items_completed_ck` ép `done` ⇔ có `completed_at`). Sửa
   * `due_date` tay thì xoá `due_text` — chữ "thứ sáu" của model không còn khớp ngày mới.
   */
  async updateIfVersion(
    id: string,
    expectedVersion: number,
    patch: ActionItemPatch,
    actorId: string,
    executor: DbExecutor = this.db,
  ): Promise<UpdateActionItemOutcome<ActionItemRow>> {
    const [row] = await executor
      .update(actionItems)
      .set({
        version: sql`${actionItems.version} + 1`,
        updatedAt: sql`now()`,
        ...(patch.task !== undefined ? { task: patch.task } : {}),
        ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate, dueText: null } : {}),
        ...(patch.status === undefined
          ? {}
          : patch.status === 'done'
            ? {
                status: patch.status,
                // Đã `done` mà đặt `done` lần nữa: giữ NGƯỜI và LÚC hoàn thành đầu tiên.
                completedAt: sql`coalesce(${actionItems.completedAt}, now())`,
                completedBy: sql`coalesce(${actionItems.completedBy}, ${actorId})`,
              }
            : { status: patch.status, completedAt: null, completedBy: null }),
      })
      .where(and(eq(actionItems.id, id), eq(actionItems.version, expectedVersion)))
      .returning();
    if (row) return { kind: 'updated', item: row };
    const [current] = await executor
      .select({ version: actionItems.version })
      .from(actionItems)
      .where(eq(actionItems.id, id));
    return current
      ? { kind: 'version_mismatch', currentVersion: current.version }
      : { kind: 'not_found' };
  }
}
