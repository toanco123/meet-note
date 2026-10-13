import { randomBytes } from 'node:crypto';
import type { Database } from '../../src/infra/database/database.types.js';
import {
  type OrgRoleValue,
  organizationMembers,
  organizations,
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
