import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import {
  organizationMembers,
  organizations,
  type OrgRoleValue,
} from '../../infra/database/schema/index.js';
import type {
  MyOrganizationRow,
  OrganizationDetailRow,
  OrganizationPatch,
} from './organizations.types.js';

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
        requireJoinApproval: organizations.requireJoinApproval,
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

  /** Khoá dòng org để đọc giá trị "trước" cho audit và tránh hai lần sửa đè nhau giữa chừng. */
  async lockForUpdate(orgId: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ name: organizations.name, requireJoinApproval: organizations.requireJoinApproval })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
      .for('update');
    return row;
  }

  async update(orgId: string, patch: OrganizationPatch, executor: DbExecutor): Promise<void> {
    await executor.update(organizations).set(patch).where(eq(organizations.id, orgId));
  }
}
