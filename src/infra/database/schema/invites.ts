import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, inValues } from './column-types.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

/** Vai trò một link mời có thể cấp. `owner` không bao giờ cấp qua link. */
export const INVITE_ROLES = ['admin', 'member'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    /** SHA-256 của token. Token gốc chỉ hiện MỘT lần lúc tạo (M3 Q1). */
    tokenHash: bytea().notNull(),
    role: text({ enum: INVITE_ROLES }).notNull().default('member'),
    createdBy: uuid(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** NULL = không giới hạn số lượt. */
    maxUses: integer(),
    useCount: integer().notNull().default(0),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'organization_invites_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'organization_invites_created_by_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    uniqueIndex('organization_invites_token_hash_uq').on(t.tokenHash),
    index('organization_invites_org_created_idx').on(
      t.orgId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check('organization_invites_role_ck', inValues(t.role, INVITE_ROLES)),
    check('organization_invites_token_hash_length_ck', sql`octet_length(${t.tokenHash}) = 32`),
    check('organization_invites_max_uses_ck', sql`${t.maxUses} is null or ${t.maxUses} > 0`),
    // Lưới an toàn cuối: kể cả code có bug, use_count không bao giờ vượt max_uses.
    check(
      'organization_invites_use_count_ck',
      sql`${t.useCount} >= 0 and (${t.maxUses} is null or ${t.useCount} <= ${t.maxUses})`,
    ),
  ],
);

export const JOIN_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const organizationJoinRequests = pgTable(
  'organization_join_requests',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    userId: uuid().notNull(),
    inviteId: uuid(),
    /** Copy từ link mời lúc tạo yêu cầu — link bị thu hồi/xoá sau đó vẫn biết cấp vai trò gì. */
    role: text({ enum: INVITE_ROLES }).notNull(),
    status: text({ enum: JOIN_REQUEST_STATUSES }).notNull().default('pending'),
    decidedBy: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'organization_join_requests_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'organization_join_requests_user_fk',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'organization_join_requests_invite_fk',
      columns: [t.inviteId],
      foreignColumns: [organizationInvites.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'organization_join_requests_decided_by_fk',
      columns: [t.decidedBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    // Một người chỉ có tối đa MỘT yêu cầu đang chờ trong một org (yêu cầu cũ đã xử lý thì không tính).
    uniqueIndex('organization_join_requests_one_pending_uq')
      .on(t.orgId, t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('organization_join_requests_org_status_idx').on(
      t.orgId,
      t.status,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    check('organization_join_requests_role_ck', inValues(t.role, INVITE_ROLES)),
    check('organization_join_requests_status_ck', inValues(t.status, JOIN_REQUEST_STATUSES)),
    check(
      'organization_join_requests_decided_ck',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`,
    ),
  ],
);

export type OrganizationInviteRow = typeof organizationInvites.$inferSelect;
export type OrganizationJoinRequestRow = typeof organizationJoinRequests.$inferSelect;
