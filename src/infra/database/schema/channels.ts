import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inValues } from './column-types.js';
import { organizationMembers, organizations } from './organizations.js';
import { users } from './users.js';

export const CHANNEL_VISIBILITIES = ['public', 'private'] as const;
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number];

export const CHANNEL_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type ChannelRoleValue = (typeof CHANNEL_ROLES)[number];

export const channels = pgTable(
  'channels',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuidv7()`),
    orgId: uuid().notNull(),
    name: text().notNull(),
    description: text(),
    visibility: text({ enum: CHANNEL_VISIBILITIES }).notNull().default('public'),
    /** Dùng ở M9 (báo cáo tuần). */
    weeklyReportEnabled: boolean().notNull().default(true),
    createdBy: uuid(),
    /** Lưu trữ = chỉ đọc. */
    archivedAt: timestamp({ withTimezone: true }),
    /** Xoá mềm → 404 với mọi người; job dọn dẹp xoá cứng sau 30 ngày. */
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: 'channels_org_fk',
      columns: [t.orgId],
      foreignColumns: [organizations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'channels_created_by_fk',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    // Đích cho composite FK của bảng con: (channel_id, org_id) phải khớp ĐÚNG org của kênh.
    unique('channels_id_org_uq').on(t.id, t.orgId),
    // Tên duy nhất trong org (không phân biệt hoa thường), chỉ tính kênh chưa xoá → xoá rồi dùng lại
    // được tên. Cũng là index cho danh sách sắp theo tên: keyset trên (lower(name), id) (M4 Q4).
    uniqueIndex('channels_org_name_uq')
      .on(t.orgId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    index('channels_purge_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    check('channels_visibility_ck', inValues(t.visibility, CHANNEL_VISIBILITIES)),
    check('channels_name_length_ck', sql`char_length(${t.name}) between 1 and 80`),
  ],
);

export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid().notNull(),
    /** Mang theo org_id để làm composite FK — DB tự chặn dữ liệu chéo tổ chức. */
    orgId: uuid().notNull(),
    userId: uuid().notNull(),
    role: text({ enum: CHANNEL_ROLES }).notNull(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'channel_members_pk', columns: [t.channelId, t.userId] }),
    // (channel_id, org_id) phải là một kênh CỦA ĐÚNG org đó.
    foreignKey({
      name: 'channel_members_channel_fk',
      columns: [t.channelId, t.orgId],
      foreignColumns: [channels.id, channels.orgId],
    }).onDelete('cascade'),
    // Người trong kênh phải là thành viên org; rời / bị gỡ khỏi org → tự rời mọi kênh.
    // BẪY: cascade xoá luôn dòng CHỦ kênh → service chặn rời/gỡ khi còn làm chủ kênh (M4 Q3).
    foreignKey({
      name: 'channel_members_org_member_fk',
      columns: [t.orgId, t.userId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete('cascade'),
    uniqueIndex('channel_members_one_owner_uq')
      .on(t.channelId)
      .where(sql`${t.role} = 'owner'`),
    index('channel_members_user_idx').on(t.userId),
    index('channel_members_channel_joined_idx').on(t.channelId, t.joinedAt, t.userId),
    check('channel_members_role_ck', inValues(t.role, CHANNEL_ROLES)),
  ],
);

export type ChannelRow = typeof channels.$inferSelect;
export type ChannelMemberRow = typeof channelMembers.$inferSelect;
