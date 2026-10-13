import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { escapeLike, timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import {
  organizationMembers,
  type OrgRoleValue,
  users,
} from '../../infra/database/schema/index.js';

export interface MemberRow {
  userId: string;
  displayName: string;
  email: string;
  role: OrgRoleValue;
  joinedAt: Date;
  /** Khoá cursor (ISO micro giây do DB sinh) — không dùng `joinedAt` (Date, chỉ mili giây). */
  joinedAtKey: string;
}

export interface ListMembersParams {
  orgId: string;
  q?: string;
  role?: OrgRoleValue;
  /** [joinedAtKey, userId] của dòng cuối trang trước. */
  after?: [string, string];
  limit: number;
}

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
}
