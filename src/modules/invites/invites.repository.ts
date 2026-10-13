import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  type InviteRole,
  organizationInvites,
  type OrganizationInviteRow,
  organizations,
} from '../../infra/database/schema/index.js';

export type InviteListRow = OrganizationInviteRow & { createdAtKey: string };

@Injectable()
export class InvitesRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insert(
    values: {
      orgId: string;
      tokenHash: Buffer;
      role: InviteRole;
      createdBy: string;
      expiresAt: Date;
      maxUses: number | null;
    },
    executor: DbExecutor,
  ): Promise<OrganizationInviteRow> {
    const [row] = await executor.insert(organizationInvites).values(values).returning();
    if (!row) throw new Error('INSERT organization_invites không trả về dòng nào');
    return row;
  }

  /**
   * Mới nhất trước: ORDER BY (created_at DESC, id DESC) — khớp index `…_org_created_idx`
   * (DESC NULLS FIRST). Trang sau = "nhỏ hơn" dòng cuối → so sánh tuple dùng `<` (ngược với ASC).
   */
  list(
    orgId: string,
    after: [string, string] | undefined,
    limit: number,
  ): Promise<InviteListRow[]> {
    return this.db
      .select({
        ...organizationInvitesColumns,
        createdAtKey: timestampKey(organizationInvites.createdAt),
      })
      .from(organizationInvites)
      .where(
        and(
          eq(organizationInvites.orgId, orgId),
          after
            ? sql`(${organizationInvites.createdAt}, ${organizationInvites.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(organizationInvites.createdAt), desc(organizationInvites.id))
      .limit(limit + 1);
  }

  async lockInOrg(
    orgId: string,
    inviteId: string,
    executor: DbExecutor,
  ): Promise<OrganizationInviteRow | undefined> {
    const [row] = await executor
      .select()
      .from(organizationInvites)
      .where(and(eq(organizationInvites.id, inviteId), eq(organizationInvites.orgId, orgId)))
      .for('update');
    return row;
  }

  /**
   * "Khoá ngầm" bằng UPDATE có điều kiện: điều kiện còn hạn / còn lượt / chưa thu hồi nằm NGAY trong
   * WHERE. Postgres khoá dòng khi UPDATE; request song song đến sau phải đợi rồi ĐÁNH GIÁ LẠI WHERE
   * trên giá trị mới (READ COMMITTED) → không bao giờ vượt `max_uses`, không cần SELECT … FOR UPDATE.
   * Không trả dòng nào = link không dùng được (lý do: gọi `findByHash` để giải thích).
   */
  async consumeUse(
    tokenHash: Buffer,
    executor: DbExecutor,
  ): Promise<{ id: string; orgId: string; role: InviteRole } | undefined> {
    const [row] = await executor
      .update(organizationInvites)
      .set({ useCount: sql`${organizationInvites.useCount} + 1` })
      .where(
        and(
          eq(organizationInvites.tokenHash, tokenHash),
          isNull(organizationInvites.revokedAt),
          gt(organizationInvites.expiresAt, sql`now()`),
          or(
            isNull(organizationInvites.maxUses),
            lt(organizationInvites.useCount, organizationInvites.maxUses),
          ),
          // Org đã xoá mềm → link vô hiệu.
          sql`exists (select 1 from ${organizations} where ${organizations.id} = ${organizationInvites.orgId} and ${organizations.deletedAt} is null)`,
        ),
      )
      .returning({
        id: organizationInvites.id,
        orgId: organizationInvites.orgId,
        role: organizationInvites.role,
      });
    return row;
  }

  /** Dùng để xem trước và để giải thích VÌ SAO `consumeUse` không trả dòng nào. */
  async findByHash(tokenHash: Buffer, executor: DbExecutor = this.db) {
    const [row] = await executor
      .select({
        invite: organizationInvites,
        orgName: organizations.name,
        requireJoinApproval: organizations.requireJoinApproval,
      })
      .from(organizationInvites)
      .innerJoin(
        organizations,
        and(eq(organizations.id, organizationInvites.orgId), isNull(organizations.deletedAt)),
      )
      .where(eq(organizationInvites.tokenHash, tokenHash));
    return row;
  }

  async markRevoked(inviteId: string, at: Date, executor: DbExecutor): Promise<void> {
    await executor
      .update(organizationInvites)
      .set({ revokedAt: at })
      .where(and(eq(organizationInvites.id, inviteId), isNull(organizationInvites.revokedAt)));
  }
}

/** Mọi cột của bảng — để `select({ ...cols, thêm })` vẫn giữ đúng kiểu row. */
const organizationInvitesColumns = {
  id: organizationInvites.id,
  orgId: organizationInvites.orgId,
  tokenHash: organizationInvites.tokenHash,
  role: organizationInvites.role,
  createdBy: organizationInvites.createdBy,
  expiresAt: organizationInvites.expiresAt,
  maxUses: organizationInvites.maxUses,
  useCount: organizationInvites.useCount,
  revokedAt: organizationInvites.revokedAt,
  createdAt: organizationInvites.createdAt,
};
