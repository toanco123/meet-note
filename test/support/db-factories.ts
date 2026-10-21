import { randomBytes } from 'node:crypto';
import type { Database } from '../../src/infra/database/database.types.js';
import {
  type ChannelRoleValue,
  type ChannelVisibility,
  channelMembers,
  channels,
  meetings,
  meetingShares,
  type OrgRoleValue,
  organizationMembers,
  organizations,
  type UploadRow,
  uploads,
  users,
} from '../../src/infra/database/schema/index.js';

/**
 * Chèn dữ liệu thẳng vào DB cho test — dùng khi chưa có API tương ứng (vd thêm thành viên
 * org trước khi có link mời ở M3) hoặc khi cần dữ liệu nền nhanh. Luồng người dùng thật
 * (đăng ký, đăng nhập) vẫn đi qua HTTP bằng `factories.ts`.
 */
export async function insertUser(
  db: Database,
  overrides: { email?: string; displayName?: string } = {},
): Promise<{ id: string; email: string; displayName: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `db-${randomBytes(5).toString('hex')}@example.com`,
      displayName: overrides.displayName ?? 'Người dùng',
      passwordHash: 'not-a-real-hash',
    })
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  if (!row) throw new Error('insertUser thất bại');
  return row;
}

/** Tạo org + Owner (giống `POST /v1/orgs`, nhưng không qua HTTP). */
export async function insertOrg(
  db: Database,
  ownerId: string,
  name = `Org ${randomBytes(3).toString('hex')}`,
): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name, createdBy: ownerId })
      .returning({ id: organizations.id, name: organizations.name });
    if (!org) throw new Error('insertOrg thất bại');
    await tx.insert(organizationMembers).values({ orgId: org.id, userId: ownerId, role: 'owner' });
    return org;
  });
}

export async function addMember(
  db: Database,
  orgId: string,
  userId: string,
  role: Exclude<OrgRoleValue, 'owner'> = 'member',
  joinedAt?: Date,
): Promise<void> {
  await db
    .insert(organizationMembers)
    .values({ orgId, userId, role, ...(joinedAt ? { joinedAt } : {}) });
}

/** Tạo kênh + chủ kênh (chủ phải là thành viên org — composite FK). */
export async function insertChannel(
  db: Database,
  orgId: string,
  ownerId: string,
  overrides: { name?: string; visibility?: ChannelVisibility } = {},
): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        name: overrides.name ?? `kenh-${randomBytes(3).toString('hex')}`,
        visibility: overrides.visibility ?? 'public',
        createdBy: ownerId,
      })
      .returning({ id: channels.id, name: channels.name });
    if (!channel) throw new Error('insertChannel thất bại');
    await tx
      .insert(channelMembers)
      .values({ channelId: channel.id, orgId, userId: ownerId, role: 'owner' });
    return channel;
  });
}

export async function addChannelMember(
  db: Database,
  channel: { id: string },
  orgId: string,
  userId: string,
  role: Exclude<ChannelRoleValue, 'owner'> = 'member',
): Promise<void> {
  await db.insert(channelMembers).values({ channelId: channel.id, orgId, userId, role });
}

export async function insertMeeting(
  db: Database,
  orgId: string,
  ownerId: string | null,
  overrides: Partial<typeof meetings.$inferInsert> = {},
): Promise<{ id: string }> {
  const [row] = await db
    .insert(meetings)
    .values({
      orgId,
      ownerId,
      title: 'Họp giao ban',
      recordedAt: new Date(),
      sourceObjectKey: `orgs/${orgId}/uploads/${randomBytes(4).toString('hex')}/source`,
      ...overrides,
    })
    .returning({ id: meetings.id });
  if (!row) throw new Error('insertMeeting thất bại');
  return row;
}

const MiB = 1024 * 1024;

/** Upload `initiated` hợp lệ (mặc định 20 MiB → 3 phần 8 MiB). Ghi đè từng cột khi cần. */
export async function insertUpload(
  db: Database,
  orgId: string,
  userId: string,
  overrides: Partial<typeof uploads.$inferInsert> = {},
): Promise<UploadRow> {
  const [row] = await db
    .insert(uploads)
    .values({
      orgId,
      userId,
      filename: 'giao-ban.m4a',
      mimeType: 'audio/mp4',
      sizeBytes: 20 * MiB,
      sha256: randomBytes(32).toString('hex'),
      chunkSize: 8 * MiB,
      totalParts: 3,
      title: 'Họp giao ban',
      recordedAt: new Date(),
      objectKey: `orgs/${orgId}/uploads/${randomBytes(4).toString('hex')}/source`,
      s3UploadId: randomBytes(8).toString('hex'),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insertUpload thất bại');
  return row;
}

/** Share thẳng vào DB (bỏ qua kiểm tra quyền của service) — dữ liệu nền cho test quyền xem. */
export async function shareMeeting(
  db: Database,
  orgId: string,
  meetingId: string,
  channelId: string,
  sharedBy: string | null = null,
): Promise<void> {
  await db.insert(meetingShares).values({ orgId, meetingId, channelId, sharedBy });
}
