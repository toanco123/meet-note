import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
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
        AuditService,
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

    const created = await service.create('Công ty ABC', { actorId: user.id });

    expect(created).toMatchObject({ name: 'Công ty ABC', role: 'owner' });
    const members = await t.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, created.id));
    expect(members).toEqual([expect.objectContaining({ userId: user.id, role: 'owner' })]);
  });

  it('create: INSERT membership lỗi SAU khi INSERT org thành công → org bị rollback', async () => {
    const user = await insertUser(t.db);
    const orgName = `Rollback ${user.id}`;
    // Org được insert THẬT; chỉ bước thứ hai hỏng. (Bản cũ của test dùng userId không tồn tại →
    // lỗi ngay ở INSERT đầu tiên do FK created_by, nên chưa từng kiểm tra được rollback.)
    const spy = vi
      .spyOn(repo, 'insertMember')
      .mockRejectedValueOnce(new Error('giả lập lỗi ở INSERT thứ hai'));

    await expect(service.create(orgName, { actorId: user.id })).rejects.toThrow(
      'giả lập lỗi ở INSERT thứ hai',
    );

    expect(spy).toHaveBeenCalledOnce();
    const leftovers = await t.db
      .select()
      .from(organizations)
      .where(eq(organizations.name, orgName));
    expect(leftovers).toHaveLength(0);
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

  it('update: đổi tên và trả chi tiết mới', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id, 'Tên cũ');

    expect(await service.update(org.id, { name: 'Tên mới' }, { actorId: owner.id })).toMatchObject({
      name: 'Tên mới',
    });
  });
});
