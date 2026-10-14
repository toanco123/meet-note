import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { escapeLike, timestampKey } from '../../../common/pagination/keys.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  channelMembers,
  channels,
  organizationMembers,
  type OrgRoleValue,
  users,
} from '../../../infra/database/schema/index.js';
import type { OwnedChannel } from '../../../common/errors/errors.types.js';
import type { ListMembersParams, MemberRow } from '../organizations.types.js';

@Injectable()
export class OrganizationMembersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Keyset pagination theo (joined_at, user_id) — khớp index `organization_members_org_joined_idx`.
   * Lấy `limit + 1` dòng để service biết còn trang sau mà không cần COUNT(*).
   */
  list({ orgId, q, role, after, limit }: ListMembersParams): Promise<MemberRow[]> {
    return this.db
      .select({
        userId: organizationMembers.userId,
        displayName: users.displayName,
        email: users.email,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        joinedAtKey: timestampKey(organizationMembers.joinedAt),
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          role ? eq(organizationMembers.role, role) : undefined,
          // search_text đã là f_unaccent(lower(tên + email)) → chuẩn hoá q y hệt rồi tìm chuỗi con.
          // Index GIN trigram (users_search_text_trgm_idx) dùng được cho LIKE '%…%'.
          q
            ? sql`${users.searchText} like '%' || f_unaccent(lower(${escapeLike(q)})) || '%' escape '\\'`
            : undefined,
          // So sánh tuple: "sau (t, id)" = t lớn hơn, HOẶC t bằng nhau và id lớn hơn.
          after
            ? sql`(${organizationMembers.joinedAt}, ${organizationMembers.userId}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(organizationMembers.joinedAt), asc(organizationMembers.userId))
      .limit(limit + 1);
  }

  /**
   * Khoá các dòng membership liên quan, LUÔN theo thứ tự `user_id` tăng dần.
   * Hai thao tác cùng chạm một người (vd Owner nâng B / Admin gỡ B) khoá cùng thứ tự → không deadlock;
   * thao tác đến sau phải đợi thao tác trước commit, rồi đọc giá trị MỚI để kiểm tra lại.
   */
  lockMembers(
    orgId: string,
    userIds: string[],
    executor: DbExecutor,
  ): Promise<Array<{ userId: string; role: OrgRoleValue }>> {
    return executor
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)),
      )
      .orderBy(asc(organizationMembers.userId))
      .for('update');
  }

  /**
   * `FOR SHARE`: nhiều giao dịch cùng ĐỌC được dòng, nhưng chặn ai `FOR UPDATE`/sửa nó (vd đổi vai trò
   * của chính người này) cho tới khi giao dịch hiện tại xong. Dùng khi cần "vai trò này phải còn
   * nguyên trong lúc tôi làm" mà không cần khoá độc quyền.
   */
  async lockRoleForShare(
    orgId: string,
    userId: string,
    executor: DbExecutor,
  ): Promise<OrgRoleValue | undefined> {
    const [row] = await executor
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .for('share');
    return row?.role;
  }

  /**
   * Nhiều dòng `FOR SHARE`, LUÔN theo `user_id` tăng dần (bậc 1 của thứ tự khoá chung). Dùng khi một
   * thao tác ở cấp kênh cần "những người này còn trong tổ chức, vai trò giữ nguyên" tới lúc commit —
   * vd chuyển chủ kênh khoá người gọi + người nhận.
   */
  lockRolesForShare(
    orgId: string,
    userIds: string[],
    executor: DbExecutor,
  ): Promise<Array<{ userId: string; role: OrgRoleValue }>> {
    return executor
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)),
      )
      .orderBy(asc(organizationMembers.userId))
      .for('share');
  }

  /**
   * Kênh (chưa xoá mềm) mà người này đang làm chủ. Đọc thẳng bảng kênh qua schema thay vì gọi module
   * kênh: module kênh đã phụ thuộc module tổ chức, gọi ngược sẽ thành vòng.
   * Gọi SAU khi đã khoá `FOR UPDATE` dòng tổ chức của người này — chuyển chủ kênh cho họ cần
   * `FOR SHARE` chính dòng đó (bậc 1), nên hai việc chạy tuần tự và kết quả ở đây là mới nhất.
   */
  findOwnedChannels(orgId: string, userId: string, executor: DbExecutor): Promise<OwnedChannel[]> {
    return executor
      .select({ id: channels.id, name: channels.name })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(
        and(
          eq(channelMembers.orgId, orgId),
          eq(channelMembers.userId, userId),
          eq(channelMembers.role, 'owner'),
          isNull(channels.deletedAt),
        ),
      )
      .orderBy(asc(sql`lower(${channels.name})`));
  }

  /** `ON CONFLICT DO NOTHING` trên PK (org_id, user_id): đã là thành viên → trả `false`, không lỗi. */
  async insertIfAbsent(
    values: { orgId: string; userId: string; role: OrgRoleValue },
    executor: DbExecutor,
  ): Promise<boolean> {
    const rows = await executor
      .insert(organizationMembers)
      .values(values)
      .onConflictDoNothing()
      .returning({ userId: organizationMembers.userId });
    return rows.length > 0;
  }

  async isMember(orgId: string, userId: string, executor: DbExecutor): Promise<boolean> {
    const [row] = await executor
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    return row !== undefined;
  }

  async updateRole(
    orgId: string,
    userId: string,
    role: OrgRoleValue,
    executor: DbExecutor,
  ): Promise<void> {
    await executor
      .update(organizationMembers)
      .set({ role })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  }

  async deleteMember(orgId: string, userId: string, executor: DbExecutor): Promise<void> {
    await executor
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  }

  async findMember(orgId: string, userId: string): Promise<MemberRow | undefined> {
    const [row] = await this.db
      .select({
        userId: organizationMembers.userId,
        displayName: users.displayName,
        email: users.email,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
        joinedAtKey: timestampKey(organizationMembers.joinedAt),
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    return row;
  }
}
