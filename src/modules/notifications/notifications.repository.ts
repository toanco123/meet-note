import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  type NotificationRow,
  notifications,
  organizations,
  users,
} from '../../infra/database/schema/index.js';
import type { ListNotificationsParams, NotificationDraft } from './notifications.types.js';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Ghi nhiều thông báo; trùng `(user_id, dedupe_key)` → bỏ qua (`ON CONFLICT DO NOTHING`). Trả CHỈ
   * các dòng vừa tạo — để đẩy realtime đúng một lần dù thao tác / job chạy lại.
   */
  async insertMany(drafts: NotificationDraft[], executor: DbExecutor): Promise<NotificationRow[]> {
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

  /** Trả id các thông báo VỪA được đánh dấu (để đồng bộ realtime — B4). */
  async markAllRead(userId: string, orgId: string | undefined): Promise<string[]> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(unreadOf(userId, orgId))
      .returning({ id: notifications.id });
    return rows.map((r) => r.id);
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

/** "Chưa đọc của người này [trong tổ chức này]" — khớp điều kiện của index partial chưa đọc. */
function unreadOf(userId: string, orgId: string | undefined): SQL {
  return and(
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
    isNull(notifications.deletedAt),
    orgId ? eq(notifications.orgId, orgId) : undefined,
  ) as SQL;
}
