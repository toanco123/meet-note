import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  organizationMembers,
  organizations,
  users,
} from '../../../../../src/infra/database/schema/index.js';
import { addMember, insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

describe('Schema organizations (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  it('mỗi org tối đa 1 owner → 23505 organization_members_one_owner_uq', async () => {
    const owner = await insertUser(t.db);
    const another = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);

    const error = await pgErrorOf(
      t.db.insert(organizationMembers).values({ orgId: org.id, userId: another.id, role: 'owner' }),
    );

    expect(error).toMatchObject({ code: '23505', constraint: 'organization_members_one_owner_uq' });
  });

  it('nhiều org khác nhau mỗi org có owner riêng — partial index chỉ ràng buộc trong một org', async () => {
    const owner = await insertUser(t.db);
    await insertOrg(t.db, owner.id);
    await expect(insertOrg(t.db, owner.id)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('một user là thành viên 2 lần trong cùng org → 23505 trên PK', async () => {
    const owner = await insertUser(t.db);
    const member = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, member.id);

    const error = await pgErrorOf(addMember(t.db, org.id, member.id, 'admin'));
    expect(error).toMatchObject({ code: '23505', constraint: 'organization_members_pk' });
  });

  it('role lạ bị CHECK chặn', async () => {
    const owner = await insertUser(t.db);
    const member = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);

    const error = await pgErrorOf(
      t.db
        .insert(organizationMembers)
        // @ts-expect-error — cố tình đưa giá trị ngoài enum để kiểm tra CHECK ở tầng DB
        .values({ orgId: org.id, userId: member.id, role: 'superadmin' }),
    );
    expect(error).toMatchObject({ code: '23514', constraint: 'organization_members_role_ck' });
  });

  it('tên org rỗng bị CHECK chặn', async () => {
    const error = await pgErrorOf(t.db.insert(organizations).values({ name: '' }));
    expect(error).toMatchObject({ code: '23514', constraint: 'organizations_name_length_ck' });
  });

  it('xoá org (xoá cứng) → cascade xoá membership', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);

    await t.db.delete(organizations).where(eq(organizations.id, org.id));

    const left = await t.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, org.id));
    expect(left).toHaveLength(0);
  });

  it('xoá user → membership mất, org còn và created_by thành NULL', async () => {
    const owner = await insertUser(t.db);
    const member = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, member.id);

    await t.db.delete(users).where(eq(users.id, owner.id));

    const [orgRow] = await t.db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(orgRow?.createdBy).toBeNull();
    const ownerMembership = await t.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, owner.id)));
    expect(ownerMembership).toHaveLength(0);
  });
});
