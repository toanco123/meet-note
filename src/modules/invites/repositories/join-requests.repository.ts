import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { timestampKey } from '../../../common/pagination/keys.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../../infra/database/database.types.js';
import {
  type InviteRole,
  organizationJoinRequests,
  type OrganizationJoinRequestRow,
  type JoinRequestStatus,
  users,
} from '../../../infra/database/schema/index.js';
import type { JoinRequestListRow } from '../invites.types.js';

@Injectable()
export class JoinRequestsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * `ON CONFLICT DO NOTHING` dựa vào partial unique index "một yêu cầu pending / (org, user)":
   * request trùng không lỗi 23505 mà trả về rỗng → service tự chọn mã lỗi nghiệp vụ.
   */
  async insertPending(
    values: { orgId: string; userId: string; inviteId: string; role: InviteRole },
    executor: DbExecutor,
  ): Promise<{ id: string } | undefined> {
    const [row] = await executor
      .insert(organizationJoinRequests)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: organizationJoinRequests.id });
    return row;
  }

  /** Mới nhất trước, khớp index `(org_id, status, created_at DESC, id DESC)`. */
  list(
    orgId: string,
    status: JoinRequestStatus,
    after: [string, string] | undefined,
    limit: number,
  ): Promise<JoinRequestListRow[]> {
    const r = organizationJoinRequests;
    return this.db
      .select({
        id: r.id,
        userId: r.userId,
        displayName: users.displayName,
        email: users.email,
        role: r.role,
        status: r.status,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        createdAtKey: timestampKey(r.createdAt),
      })
      .from(r)
      .innerJoin(users, eq(users.id, r.userId))
      .where(
        and(
          eq(r.orgId, orgId),
          eq(r.status, status),
          after
            ? sql`(${r.createdAt}, ${r.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(r.createdAt), desc(r.id))
      .limit(limit + 1);
  }

  /**
   * Khoá dòng yêu cầu: hai Admin bấm duyệt cùng lúc → người sau đợi, rồi thấy status đã khác
   * `pending`. UPDATE có điều kiện không đủ ở đây vì duyệt còn phải kiểm tra quyền cấp vai trò và
   * ghi nhiều bảng (thành viên, yêu cầu, audit) dựa trên dữ liệu vừa đọc.
   */
  async lockInOrg(
    orgId: string,
    requestId: string,
    executor: DbExecutor,
  ): Promise<OrganizationJoinRequestRow | undefined> {
    const [row] = await executor
      .select()
      .from(organizationJoinRequests)
      .where(
        and(eq(organizationJoinRequests.id, requestId), eq(organizationJoinRequests.orgId, orgId)),
      )
      .for('update');
    return row;
  }

  async decide(
    requestId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; decidedAt: Date },
    executor: DbExecutor,
  ): Promise<void> {
    await executor
      .update(organizationJoinRequests)
      .set(decision)
      .where(eq(organizationJoinRequests.id, requestId));
  }
}
