import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  organizationMembers,
  organizations,
  type OrgRoleValue,
} from '../../infra/database/schema/index.js';

export interface MyOrganizationRow {
  id: string;
  name: string;
  role: OrgRoleValue;
  joinedAt: Date;
}

export interface OrganizationDetailRow {
  id: string;
  name: string;
  createdAt: Date;
  memberCount: number;
}

@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insertOrganization(name: string, createdBy: string, executor: DbExecutor = this.db) {
    const [row] = await executor.insert(organizations).values({ name, createdBy }).returning();
    if (!row) throw new Error('INSERT organizations không trả về dòng nào');
    return row;
  }

  async insertMember(
    values: { orgId: string; userId: string; role: OrgRoleValue },
    executor: DbExecutor = this.db,
  ) {
    const [row] = await executor.insert(organizationMembers).values(values).returning();
    if (!row) throw new Error('INSERT organization_members không trả về dòng nào');
    return row;
  }

  /**
   * Guard gọi ở MỖI request có `:orgId`: tra PK `(org_id, user_id)` + join lọc org đã xoá mềm.
   * Không khoá — chỉ để trả lời "có phải thành viên không"; service sẽ khoá + kiểm tra lại khi ghi.
   */
  async findMembership(orgId: string, userId: string): Promise<{ role: OrgRoleValue } | undefined> {
    const [row] = await this.db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          isNull(organizations.deletedAt),
        ),
      );
    return row;
  }

  /** Dùng index `organization_members_user_idx`. Ít dòng (một người thuộc ít org) → không phân trang. */
  listForUser(userId: string): Promise<MyOrganizationRow[]> {
    return this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        role: organizationMembers.role,
        joinedAt: organizationMembers.joinedAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
      .orderBy(asc(organizationMembers.joinedAt), asc(organizations.id));
  }

  async findDetail(orgId: string): Promise<OrganizationDetailRow | undefined> {
    const [row] = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        createdAt: organizations.createdAt,
        // Sub-query đếm trên PK (org_id, …) — index-only scan, không cần GROUP BY cả bảng org.
        memberCount: sql<number>`(
          select count(*)::int from ${organizationMembers}
          where ${organizationMembers.orgId} = ${organizations.id}
        )`,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)));
    return row;
  }

  async updateName(orgId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .update(organizations)
      .set({ name })
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .returning({ id: organizations.id });
    return rows.length > 0;
  }
}
