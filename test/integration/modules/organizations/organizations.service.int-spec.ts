import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { organizationMembers, organizations } from '../../../../src/infra/database/schema/index.js';
import { OrganizationsRepository } from '../../../../src/modules/organizations/organizations.repository.js';
import { OrganizationsService } from '../../../../src/modules/organizations/organizations.service.js';
import { addMember, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

describe('OrganizationsService (Postgres thật)', () => {
  let t: TestDb;
  let service: OrganizationsService;
  let repo: OrganizationsRepository;

  beforeAll(async () => {
    t = createTestDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        OrganizationsRepository,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(OrganizationsService);
    repo = moduleRef.get(OrganizationsRepository);
  });

  afterAll(async () => {
    await t.close();
  });

  it('create: tạo org + đúng 1 membership owner cho người tạo', async () => {
    const user = await insertUser(t.db);

    const created = await service.create(user.id, 'Công ty ABC');

    expect(created).toMatchObject({ name: 'Công ty ABC', role: 'owner' });
    const members = await t.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, created.id));
    expect(members).toEqual([expect.objectContaining({ userId: user.id, role: 'owner' })]);
  });

  it('create: insert membership lỗi → org cũng không được tạo (cùng transaction)', async () => {
    const before = await t.db.select().from(organizations);
    // userId không tồn tại → FK của organization_members lỗi ở INSERT thứ hai
    await expect(
      service.create('00000000-0000-7000-8000-000000000000', 'Org mồ côi'),
    ).rejects.toThrow();
    const after = await t.db.select().from(organizations);
    expect(after).toHaveLength(before.length);
  });

  it('listMine: chỉ org mình là thành viên, bỏ org đã xoá mềm, kèm vai trò', async () => {
    const me = await insertUser(t.db);
    const stranger = await insertUser(t.db);
    const mine = await insertOrg(t.db, me.id, 'Của tôi');
    const joined = await insertOrg(t.db, stranger.id, 'Tôi là admin');
    await addMember(t.db, joined.id, me.id, 'admin');
    await insertOrg(t.db, stranger.id, 'Không liên quan');
    const deleted = await insertOrg(t.db, me.id, 'Đã xoá');
    await t.db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, deleted.id));

    const list = await service.listMine(me.id);

    expect(list.map((o) => [o.id, o.role])).toEqual([
      [mine.id, 'owner'],
      [joined.id, 'admin'],
    ]);
  });

  it('getDetail: đếm đúng số thành viên', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, (await insertUser(t.db)).id);
    await addMember(t.db, org.id, (await insertUser(t.db)).id, 'admin');

    expect(await service.getDetail(org.id)).toMatchObject({ id: org.id, memberCount: 3 });
  });

  it('findMembership: org đã xoá mềm → undefined (guard sẽ trả 404)', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    expect(await repo.findMembership(org.id, owner.id)).toEqual({ role: 'owner' });

    await t.db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, org.id));

    expect(await repo.findMembership(org.id, owner.id)).toBeUndefined();
  });

  it('rename: đổi tên và trả chi tiết mới', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id, 'Tên cũ');

    expect(await service.rename(org.id, 'Tên mới')).toMatchObject({ name: 'Tên mới' });
  });
});
