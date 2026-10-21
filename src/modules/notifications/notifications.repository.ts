import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  type NotificationRow,
  notifications,
  organizations,
  users,
} from '../../infra/database/schema/index.js';
import type { NotificationDraft } from './notifications.types.js';

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
}
