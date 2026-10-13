import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { timestampKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  type InviteRole,
  organizationInvites,
  type OrganizationInviteRow,
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
