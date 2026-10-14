import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { escapeLike } from '../../../common/pagination/keys.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  channelMembers,
  type ChannelRoleValue,
  channels,
  type ChannelVisibility,
} from '../../../infra/database/schema/index.js';
import type {
  ChannelAccessRow,
  ChannelDetailRow,
  ChannelPatch,
  ListChannelsParams,
  LockedChannel,
} from '../channels.types.js';

export const CHANNELS_ORG_NAME_UNIQUE = 'channels_org_name_uq';

/** Dòng membership CỦA NGƯỜI GỌI (alias để không lẫn với `channel_members` trong sub-query đếm). */
const mine = alias(channelMembers, 'mine');

const nameKey = sql<string>`lower(${channels.name})`;

const detailColumns = {
  id: channels.id,
  name: channels.name,
  description: channels.description,
  visibility: channels.visibility,
  weeklyReportEnabled: channels.weeklyReportEnabled,
  archivedAt: channels.archivedAt,
  createdAt: channels.createdAt,
  // Đếm trên PK (channel_id, user_id) → index-only scan, chạy ≤ limit lần mỗi trang.
  memberCount: sql<number>`(
    select count(*)::int from ${channelMembers}
    where ${channelMembers.channelId} = ${channels.id}
  )`,
  myRole: mine.role,
  nameKey,
};

@Injectable()
export class ChannelsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Guard gọi: kênh (chưa xoá, ĐÚNG org trên path) + vai trò của người gọi trong một query.
   * Lọc theo `org_id` là bắt buộc: thiếu nó, `/orgs/A/channels/<kênh của org B>` sẽ lọt qua.
   */
  async findAccess(
    orgId: string,
    channelId: string,
    userId: string,
  ): Promise<ChannelAccessRow | undefined> {
    const [row] = await this.db
      .select({
        id: channels.id,
        visibility: channels.visibility,
        archivedAt: channels.archivedAt,
        channelRole: mine.role,
      })
      .from(channels)
      .leftJoin(mine, and(eq(mine.channelId, channels.id), eq(mine.userId, userId)))
      .where(
        and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.deletedAt)),
      );
    return row;
  }

  async findDetail(channelId: string, userId: string): Promise<ChannelDetailRow | undefined> {
    const [row] = await this.db
      .select(detailColumns)
      .from(channels)
      .leftJoin(mine, and(eq(mine.channelId, channels.id), eq(mine.userId, userId)))
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));
    return row;
  }

  /**
   * Keyset theo BIỂU THỨC `lower(name)` — khớp index `channels_org_name_uq (org_id, lower(name))
   * WHERE deleted_at IS NULL` nên Postgres đọc thẳng index theo thứ tự, không Sort.
   *
   * - Không cần `id` làm tie-breaker: index unique đảm bảo `lower(name)` không trùng trong tập
   *   (cùng org, chưa xoá) mà danh sách này duyệt.
   * - Khoá cursor phải là `lower(name)` do Postgres tính, KHÔNG phải `name.toLowerCase()` của JS:
   *   hai bên có thể lower khác nhau với vài ký tự Unicode → so sánh `>` lệch → lặp/mất dòng.
   */
  list(p: ListChannelsParams): Promise<ChannelDetailRow[]> {
    return this.db
      .select(detailColumns)
      .from(channels)
      .leftJoin(mine, and(eq(mine.channelId, channels.id), eq(mine.userId, p.userId)))
      .where(
        and(
          eq(channels.orgId, p.orgId),
          isNull(channels.deletedAt),
          p.seeAll ? undefined : or(eq(channels.visibility, 'public'), isNotNull(mine.userId)),
          p.visibility ? eq(channels.visibility, p.visibility) : undefined,
          p.archived ? isNotNull(channels.archivedAt) : isNull(channels.archivedAt),
          // Không có index trigram cho tên kênh: lọc trên các dòng của MỘT org (ít) là đủ.
          p.q
            ? sql`f_unaccent(lower(${channels.name})) like '%' || f_unaccent(lower(${escapeLike(p.q)})) || '%' escape '\\'`
            : undefined,
          p.after === undefined ? undefined : sql`${nameKey} > ${p.after}`,
        ),
      )
      .orderBy(asc(nameKey))
      .limit(p.limit + 1);
  }

  async insertChannel(
    values: {
      orgId: string;
      name: string;
      description: string | null;
      visibility: ChannelVisibility;
      createdBy: string;
    },
    executor: DbExecutor,
  ): Promise<{ id: string }> {
    const [row] = await executor.insert(channels).values(values).returning({ id: channels.id });
    if (!row) throw new Error('INSERT channels không trả về dòng nào');
    return row;
  }

  async insertMember(
    values: { channelId: string; orgId: string; userId: string; role: ChannelRoleValue },
    executor: DbExecutor,
  ): Promise<void> {
    await executor.insert(channelMembers).values(values);
  }

  /**
   * Khoá dòng kênh = MUTEX cho mọi thay đổi của kênh đó (metadata, thành viên, chủ kênh — B4/B5).
   * Đọc luôn giá trị "trước" cho audit.
   */
  async lockForUpdate(channelId: string, executor: DbExecutor): Promise<LockedChannel | undefined> {
    const [row] = await executor
      .select({
        name: channels.name,
        description: channels.description,
        visibility: channels.visibility,
        weeklyReportEnabled: channels.weeklyReportEnabled,
        archivedAt: channels.archivedAt,
      })
      .from(channels)
      .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
      .for('update');
    return row;
  }

  /** Không khoá: gọi SAU khi đã khoá dòng kênh — mọi thay đổi thành viên đều phải khoá dòng đó trước. */
  async findMemberRole(
    channelId: string,
    userId: string,
    executor: DbExecutor,
  ): Promise<ChannelRoleValue | null> {
    const [row] = await executor
      .select({ role: channelMembers.role })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
    return row?.role ?? null;
  }

  async update(channelId: string, patch: ChannelPatch, executor: DbExecutor): Promise<void> {
    await executor.update(channels).set(patch).where(eq(channels.id, channelId));
  }
}
