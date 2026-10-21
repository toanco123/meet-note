import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
} from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  channelMembers,
  channels,
  meetingShares,
  meetings,
  type NotificationRow,
  notifications,
  organizations,
  users,
} from '../../infra/database/schema/index.js';
import type {
  FanoutRecipientsParams,
  ListNotificationsParams,
  NotificationDraft,
} from './notifications.types.js';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Ghi nhiều thông báo; trùng `(user_id, dedupe_key)` → bỏ qua (`ON CONFLICT DO NOTHING`). Trả CHỈ
   * các dòng vừa tạo — để đẩy realtime đúng một lần dù thao tác / job chạy lại.
   */
  async insertMany(
    drafts: NotificationDraft[],
    executor: DbExecutor = this.db,
  ): Promise<NotificationRow[]> {
    if (drafts.length === 0) return [];
    return executor
      .insert(notifications)
      .values(
        drafts.map((d) => ({
          userId: d.userId,
          orgId: d.orgId,
          type: d.type,
          payload: d.payload,
          dedupeKey: d.dedupeKey ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning();
  }

  /** Tên hiển thị để chép vào payload (M10 Q4). */
  async displayNames(
    userIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await executor
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async orgName(orgId: string, executor: DbExecutor = this.db): Promise<string> {
    const [row] = await executor
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return row?.name ?? '';
  }

  /**
   * Share còn "sống" lúc job chạy (M10 B5): còn dòng share, meeting và kênh chưa xoá. `undefined` =
   * đã gỡ share / xoá trước khi job tới lượt → không gửi cho ai.
   */
  async findLiveShare(meetingId: string, channelId: string) {
    const [row] = await this.db
      .select({
        orgId: meetingShares.orgId,
        sharedBy: meetingShares.sharedBy,
        meetingTitle: meetings.title,
        channelName: channels.name,
      })
      .from(meetingShares)
      .innerJoin(meetings, eq(meetings.id, meetingShares.meetingId))
      .innerJoin(channels, eq(channels.id, meetingShares.channelId))
      .where(liveShare(meetingId, channelId));
    return row;
  }

  /**
   * Một lô người nhận "meeting được chia sẻ": thành viên kênh trừ khách (Q1) và người share, keyset
   * theo `user_id` (PK `(channel_id, user_id)` phục vụ cả lọc lẫn thứ tự). Mỗi lô KIỂM LẠI share còn
   * sống: gỡ share giữa chừng → các lô sau rỗng.
   */
  async fanoutRecipients(p: FanoutRecipientsParams): Promise<string[]> {
    const rows = await this.db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, p.channelId),
          ne(channelMembers.role, 'guest'),
          p.excludeUserId ? ne(channelMembers.userId, p.excludeUserId) : undefined,
          p.afterUserId ? gt(channelMembers.userId, p.afterUserId) : undefined,
          exists(
            this.db
              .select({ one: sql`1` })
              .from(meetingShares)
              .innerJoin(meetings, eq(meetings.id, meetingShares.meetingId))
              .innerJoin(channels, eq(channels.id, meetingShares.channelId))
              .where(liveShare(p.meetingId, p.channelId)),
          ),
        ),
      )
      .orderBy(asc(channelMembers.userId))
      .limit(p.limit);
    return rows.map((r) => r.userId);
  }

  /** Keyset `(created_at DESC, id DESC)` trên `notifications_user_created_idx`; `limit + 1` dòng. */
  list(p: ListNotificationsParams): Promise<Array<NotificationRow & { createdAtKey: string }>> {
    return this.db
      .select({
        ...getTableColumns(notifications),
        createdAtKey: timestampKey(notifications.createdAt),
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, p.userId),
          isNull(notifications.deletedAt),
          p.orgId ? eq(notifications.orgId, p.orgId) : undefined,
          p.unreadOnly ? isNull(notifications.readAt) : undefined,
          p.after
            ? sql`(${notifications.createdAt}, ${notifications.id}) < (${p.after.createdAt}::timestamptz, ${p.after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(p.limit + 1);
  }

  /**
   * Đếm chưa đọc CÓ TRẦN (M10 Q5): `count(*)` trên subquery `LIMIT cap` — dừng quét sau `cap` dòng
   * dù người dùng có 100k thông báo chưa đọc. Dùng `notifications_user_unread_idx`.
   */
  async countUnread(userId: string, orgId: string | undefined, cap: number): Promise<number> {
    const result = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select 1 from ${notifications}
        where ${unreadOf(userId, orgId)}
        limit ${cap}
      ) capped`);
    return result.rows[0]?.n ?? 0;
  }

  /** `coalesce` giữ mốc đọc lần đầu — gọi lại không đổi gì (idempotent). `false` = không có / của người khác. */
  async markRead(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.deletedAt),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length > 0;
  }

  /**
   * Trả SỐ dòng vừa đánh dấu, không trả id: có thể là hàng chục nghìn dòng — `RETURNING` cả loạt chỉ
   * để biết "có đổi gì không" là phí.
   */
  async markAllRead(userId: string, orgId: string | undefined): Promise<number> {
    const result = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(unreadOf(userId, orgId));
    return result.rowCount ?? 0;
  }

  async softDelete(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(notifications)
      .set({ deletedAt: sql`coalesce(${notifications.deletedAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning({ id: notifications.id });
    return rows.length > 0;
  }
}

/** Dùng chung cho đọc share và kiểm lại mỗi lô — cần join `meetings` + `channels`. */
function liveShare(meetingId: string, channelId: string): SQL {
  return and(
    eq(meetingShares.meetingId, meetingId),
    eq(meetingShares.channelId, channelId),
    isNull(meetings.deletedAt),
    isNull(channels.deletedAt),
  ) as SQL;
}

/** "Chưa đọc của người này [trong tổ chức này]" — khớp điều kiện của index partial chưa đọc. */
function unreadOf(userId: string, orgId: string | undefined): SQL {
  return and(
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
    isNull(notifications.deletedAt),
    orgId ? eq(notifications.orgId, orgId) : undefined,
  ) as SQL;
}
