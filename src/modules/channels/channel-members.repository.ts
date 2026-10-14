import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { escapeLike, timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { channelMembers, type ChannelRoleValue, users } from '../../infra/database/schema/index.js';

export interface ChannelMemberRow {
  userId: string;
  displayName: string;
  email: string;
  role: ChannelRoleValue;
  joinedAt: Date;
  /** Khoá cursor (ISO micro giây do DB sinh). */
  joinedAtKey: string;
}

export interface ListChannelMembersParams {
  channelId: string;
  q?: string;
  role?: ChannelRoleValue;
  /** [joinedAtKey, userId] của dòng cuối trang trước. */
  after?: [string, string];
  limit: number;
}

const memberColumns = {
  userId: channelMembers.userId,
  displayName: users.displayName,
  email: users.email,
  role: channelMembers.role,
  joinedAt: channelMembers.joinedAt,
  joinedAtKey: timestampKey(channelMembers.joinedAt),
};

@Injectable()
export class ChannelMembersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Keyset theo (joined_at, user_id) — khớp index `channel_members_channel_joined_idx
   * (channel_id, joined_at, user_id)`. Cùng mẫu với danh sách thành viên tổ chức.
   */
  list({
    channelId,
    q,
    role,
    after,
    limit,
  }: ListChannelMembersParams): Promise<ChannelMemberRow[]> {
    return this.db
      .select(memberColumns)
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          role ? eq(channelMembers.role, role) : undefined,
          q
            ? sql`${users.searchText} like '%' || f_unaccent(lower(${escapeLike(q)})) || '%' escape '\\'`
            : undefined,
          after
            ? sql`(${channelMembers.joinedAt}, ${channelMembers.userId}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.userId))
      .limit(limit + 1);
  }

  async findMember(channelId: string, userId: string): Promise<ChannelMemberRow | undefined> {
    const [row] = await this.db
      .select(memberColumns)
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
    return row;
  }

  /**
   * Bậc 3 của thứ tự khoá chung — gọi SAU khi đã khoá dòng kênh.
   * Vẫn phải khoá dù dòng kênh đã là mutex: gỡ người khỏi TỔ CHỨC xoá dòng này qua cascade mà
   * không đi qua dòng kênh. Không khoá → đọc thấy dòng cũ, UPDATE sau đó trúng 0 dòng mà không báo
   * lỗi, rồi vẫn ghi audit cho một thay đổi không xảy ra.
   */
  async lockMember(
    channelId: string,
    userId: string,
    executor: DbExecutor,
  ): Promise<ChannelRoleValue | undefined> {
    const [row] = await executor
      .select({ role: channelMembers.role })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
      .for('update');
    return row?.role;
  }

  /** `ON CONFLICT DO NOTHING` trên PK (channel_id, user_id): đã là thành viên → `false`, không lỗi. */
  async insertIfAbsent(
    values: { channelId: string; orgId: string; userId: string; role: ChannelRoleValue },
    executor: DbExecutor,
  ): Promise<boolean> {
    const rows = await executor
      .insert(channelMembers)
      .values(values)
      .onConflictDoNothing()
      .returning({ userId: channelMembers.userId });
    return rows.length > 0;
  }

  async updateRole(
    channelId: string,
    userId: string,
    role: ChannelRoleValue,
    executor: DbExecutor,
  ): Promise<void> {
    await executor
      .update(channelMembers)
      .set({ role })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  }

  async deleteMember(channelId: string, userId: string, executor: DbExecutor): Promise<void> {
    await executor
      .delete(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
  }
}
