import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { organizationMembers } from './organizations.js';
import { users } from './users.js';

/**
 * Loại thông báo (M10 Q1). Thêm loại mới = sửa CHECK bằng migration — đúng quy ước enum = text + CHECK.
 * M6 thêm `meeting.completed` / `meeting.failed`, M9 thêm `report.ready`.
 */
export const NOTIFICATION_TYPES = [
  'channel.member_added',
  'channel.ownership_transferred',
  'org.join_request_approved',
  'meeting.shared',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Thông báo in-app của MỘT người (03 §6, M10). DB là nguồn sự thật; Socket.IO chỉ đẩy gợi ý khi
 * người dùng đang kết nối (02 §2).
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    userId: uuid().notNull(),
    /** NULL = không thuộc tổ chức nào (vd thông báo hệ thống về tài khoản). */
    orgId: uuid(),
    type: text({ enum: NOTIFICATION_TYPES }).notNull(),
    /** Id + tên LÚC TẠO (M10 Q4) — đọc danh sách không phải join, đổi tên sau không làm sai câu cũ. */
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    /**
     * Khoá chống trùng khi thao tác / job chạy lại, vd `meeting-shared.{meetingId}.{channelId}` — cũng
     * là đuôi `jobId` của fan-out nên KHÔNG có `:` (BullMQ cấm).
     */
    dedupeKey: text(),
    readAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'notifications_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    /**
     * M10 Q3 — rời / bị gỡ khỏi tổ chức thì không còn thấy thông báo của tổ chức đó: cascade XOÁ theo
     * dòng thành viên, thay vì JOIN `organization_members` ở mọi truy vấn đọc. `org_id` NULL → FK không
     * áp (MATCH SIMPLE), thông báo không thuộc tổ chức nào vẫn giữ.
     */
    foreignKey({
      name: 'notifications_org_member_fk',
      columns: [t.orgId, t.userId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete('cascade'),
    uniqueIndex('notifications_user_dedupe_uq')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    // Danh sách: keyset (created_at DESC, id DESC) của MỘT người. KHÔNG partial: cũng là index phía
    // tham chiếu của FK `user_id` (xoá user → tìm thông báo của họ) — partial thì FK không dùng được
    // (M5 bài học 2). Thông báo xoá mềm ít → lọc `deleted_at` lúc đọc là đủ.
    index('notifications_user_created_idx').on(t.userId, t.createdAt.desc(), t.id.desc()),
    // Đếm chưa đọc (M10 Q5).
    index('notifications_user_unread_idx')
      .on(t.userId)
      .where(sql`${t.readAt} is null and ${t.deletedAt} is null`),
    // Phía tham chiếu của FK tổ chức: gỡ thành viên → tìm thông báo của (org, user) để cascade.
    index('notifications_org_user_idx').on(t.orgId, t.userId),
    check('notifications_type_ck', inValues(t.type, NOTIFICATION_TYPES)),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
