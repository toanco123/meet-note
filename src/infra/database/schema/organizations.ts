import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { users } from './users.js';

export const ORG_ROLES = ['owner', 'admin', 'member'] as const;
export type OrgRoleValue = (typeof ORG_ROLES)[number];

export const organizations = pgTable(
  'organizations',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    /** Không unique toàn hệ thống — nhiều tổ chức có thể trùng tên. */
    name: text().notNull(),
    /** Ai tạo. SET NULL khi user bị xoá: lịch sử tạo không quan trọng bằng việc giữ org. */
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Xoá mềm (tính năng xoá org làm ở M4). Mọi truy vấn org phải lọc `deleted_at IS NULL`. */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'organizations_created_by_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    check('organizations_name_length_ck', sql`char_length(${t.name}) between 1 and 100`),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    orgId: uuid().notNull(),
    userId: uuid().notNull(),
    role: text({ enum: ORG_ROLES }).notNull(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'organization_members_pk', columns: [t.orgId, t.userId] }),
    foreignKey({
      name: 'organization_members_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'organization_members_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check('organization_members_role_ck', inValues(t.role, ORG_ROLES)),
    // Bất biến "mỗi org tối đa 1 owner" ép ở DB. Partial unique index KHÔNG deferrable được →
    // chuyển quyền sở hữu (M3) phải hạ owner cũ TRƯỚC rồi mới nâng owner mới.
    uniqueIndex('organization_members_one_owner_uq')
      .on(t.orgId)
      .where(sql`${t.role} = 'owner'`),
    // "Các org của tôi": PK bắt đầu bằng org_id nên không dùng được cho tra theo user_id.
    index('organization_members_user_idx').on(t.userId),
    // Phân trang danh sách thành viên: khớp đúng ORDER BY (joined_at, user_id) trong một org.
    index('organization_members_org_joined_idx').on(t.orgId, t.joinedAt, t.userId),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
