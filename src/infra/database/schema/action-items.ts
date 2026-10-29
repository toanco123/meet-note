import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { meetings } from './meetings.js';
import { users } from './users.js';

export const ACTION_ITEM_STATUSES = ['open', 'done', 'dismissed'] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];

export const ACTION_ITEM_ORIGINS = ['ai', 'manual'] as const;
export type ActionItemOrigin = (typeof ACTION_ITEM_ORIGINS)[number];

/**
 * Việc cần làm của một meeting (M12). Dữ liệu HAI NGUỒN: máy (`origin = 'ai'`, trích từ tóm tắt) và
 * người (`manual`, hoặc việc AI đã bị sửa). Quy tắc giữ hai nguồn không giẫm nhau:
 * - pipeline chỉ CHÈN việc AI (`ON CONFLICT DO NOTHING` trên `action_items_ai_source_uq`), không bao
 *   giờ UPDATE / DELETE → chạy lại không sinh trùng và không đè bản đã sửa;
 * - không có xoá: bỏ việc = `status = 'dismissed'` (xoá hẳn một việc AI thì lần chạy lại chèn lại nó).
 *
 * KHOÁ NGOẠI `(org_id, assignee_id) → organization_members` KHÔNG khai báo ở đây — cùng lý do với
 * `meetings.owner_id`: cần `ON DELETE SET NULL (assignee_id)` (PostgreSQL 15+), Drizzle chỉ sinh được
 * `SET NULL` cho cả hai cột → `org_id NOT NULL` vỡ (23502) và gỡ thành viên khỏi org thất bại.
 * Ràng buộc nằm ở migration `0018` (phần viết tay). RLS theo `org_id` cũng ở đó.
 */
export const actionItems = pgTable(
  'action_items',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    meetingId: uuid().notNull(),
    origin: text({ enum: ACTION_ITEM_ORIGINS }).notNull(),
    /** Vị trí trong `actionItems` của tóm tắt; khoá tự nhiên của việc AI. NULL với `manual`. */
    sourceIndex: integer(),
    task: text().notNull(),
    /** Tên người phụ trách model nêu, giữ nguyên chữ — để giao tay khi chưa map được thành viên. */
    ownerName: text(),
    /** NULL = chưa giao / không map được / người đó đã rời tổ chức. */
    assigneeId: uuid(),
    /** Hạn model nêu, giữ chữ gốc ("thứ sáu") để hiển thị. Sửa `due_date` tay thì xoá cột này. */
    dueText: text(),
    /** Hạn đã quy ra ngày (model quy theo ngày họp, server validate lại). */
    dueDate: date({ mode: 'string' }),
    status: text({ enum: ACTION_ITEM_STATUSES }).notNull().default('open'),
    completedAt: timestamp({ withTimezone: true }),
    completedBy: uuid(),
    /** Khoá lạc quan (M13 Q7): mỗi lần sửa +1, client gửi lại qua `If-Match`. */
    version: integer().notNull().default(1),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'action_items_meeting_fk',
      columns: [t.meetingId, t.orgId],
      foreignColumns: [meetings.id, meetings.orgId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'action_items_completed_by_fk',
      columns: [t.completedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'action_items_created_by_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    // KHOÁ IDEMPOTENCY của pipeline: cùng meeting + cùng vị trí trong tóm tắt = cùng một việc.
    uniqueIndex('action_items_ai_source_uq')
      .on(t.meetingId, t.sourceIndex)
      .where(sql`${t.origin} = 'ai'`),
    index('action_items_meeting_idx').on(t.meetingId, t.id),
    // "Việc của tôi" (Q8). KHÔNG partial: cũng là index phía tham chiếu cho FK assignee viết tay —
    // gỡ một thành viên org thì Postgres phải tìm MỌI việc (mọi trạng thái) của người đó; index
    // `WHERE status = 'open'` không dùng được cho lần tìm đó (cùng bẫy với `meetings_org_owner_*`).
    index('action_items_org_assignee_due_idx').on(
      t.orgId,
      t.assigneeId,
      t.status,
      t.dueDate.asc().nullsLast(),
      t.id,
    ),
    index('action_items_completed_by_idx')
      .on(t.completedBy)
      .where(sql`${t.completedBy} is not null`),
    index('action_items_created_by_idx')
      .on(t.createdBy)
      .where(sql`${t.createdBy} is not null`),
    check('action_items_status_ck', inValues(t.status, ACTION_ITEM_STATUSES)),
    check('action_items_origin_ck', inValues(t.origin, ACTION_ITEM_ORIGINS)),
    check('action_items_version_ck', sql`${t.version} >= 1`),
    check('action_items_task_length_ck', sql`char_length(${t.task}) between 1 and 500`),
    check('action_items_owner_name_length_ck', sql`char_length(${t.ownerName}) between 1 and 200`),
    check('action_items_due_text_length_ck', sql`char_length(${t.dueText}) between 1 and 200`),
    // Việc AI luôn có khoá tự nhiên; việc thủ công không có (nếu có sẽ đụng unique của AI).
    // BẪY ba giá trị: `source_index >= 0` với NULL ra NULL, mà CHECK coi NULL là THOẢ → phải có
    // `is not null` tường minh (lần đầu thiếu: AI không có source_index lọt qua, test bắt được).
    check(
      'action_items_source_ck',
      sql`(${t.origin} = 'ai' and ${t.sourceIndex} is not null and ${t.sourceIndex} >= 0) or (${t.origin} = 'manual' and ${t.sourceIndex} is null)`,
    ),
    // `done` ⇔ có thời điểm hoàn thành.
    check(
      'action_items_completed_ck',
      sql`(${t.status} = 'done') = (${t.completedAt} is not null)`,
    ),
  ],
);

export type ActionItemRow = typeof actionItems.$inferSelect;
export type NewActionItemRow = typeof actionItems.$inferInsert;
