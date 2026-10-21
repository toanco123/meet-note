import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { auditLogs, organizationMembers } from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/repositories/organization-members.repository.js';
import { OrganizationMembersService } from '../../../../src/modules/organizations/services/organization-members.service.js';
import { OrganizationsRepository } from '../../../../src/modules/organizations/repositories/organizations.repository.js';
import { OrganizationsService } from '../../../../src/modules/organizations/services/organizations.service.js';
import { addMember, insertOrg, insertUser } from '../../../support/db-factories.js';
import { realtimeStub } from '../../../support/realtime-stub.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

describe('Audit log gắn vào thao tác M2 (Postgres thật)', () => {
  let t: TestDb;
  let orgs: OrganizationsService;
  let members: OrganizationMembersService;

  beforeAll(async () => {
    t = createTestDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        OrganizationsRepository,
        OrganizationMembersService,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
        realtimeStub,
      ],
    }).compile();
    orgs = moduleRef.get(OrganizationsService);
    members = moduleRef.get(OrganizationMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  const logsOf = (orgId: string) =>
    t.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).orderBy(auditLogs.id);

  async function setup() {
    const owner = await insertUser(t.db);
    const target = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, target.id, 'member');
    return { owner, target, org };
  }

  it('tạo org → ghi org.created trong cùng transaction', async () => {
    const owner = await insertUser(t.db);
    const created = await orgs.create('Có audit', { actorId: owner.id, requestId: 'req-1' });

    expect(await logsOf(created.id)).toEqual([
      expect.objectContaining({
        action: 'org.created',
        actorId: owner.id,
        requestId: 'req-1',
        metadata: { after: { name: 'Có audit' } },
      }),
    ]);
  });

  it('đổi vai trò → org.member.role_changed với { before, after }, actor, request id, ip', async () => {
    const { owner, target, org } = await setup();

    await members.changeRole(org.id, target.id, 'admin', {
      actorId: owner.id,
      requestId: 'req-42',
      ip: '203.0.113.9',
    });

    const [log] = await logsOf(org.id);
    expect(log).toMatchObject({
      action: 'org.member.role_changed',
      actorId: owner.id,
      targetType: 'member',
      targetId: target.id,
      metadata: { before: { role: 'member' }, after: { role: 'admin' } },
      requestId: 'req-42',
      ip: '203.0.113.9',
    });
  });

  it('không đổi gì (member → member) → không ghi audit', async () => {
    const { owner, target, org } = await setup();
    await members.changeRole(org.id, target.id, 'member', { actorId: owner.id });
    expect(await logsOf(org.id)).toEqual([]);
  });

  it('thao tác bị từ chối (Admin đổi vai trò) → không có audit', async () => {
    const { target, org } = await setup();
    const admin = await insertUser(t.db);
    await addMember(t.db, org.id, admin.id, 'admin');

    await expect(
      members.changeRole(org.id, target.id, 'admin', { actorId: admin.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await logsOf(org.id)).toEqual([]);
  });

  it('sửa org chỉ ghi field thực sự đổi; sửa y nguyên → không ghi', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id, 'Tên A');

    await orgs.update(org.id, { name: 'Tên A' }, { actorId: owner.id });
    await orgs.update(org.id, { name: 'Tên B' }, { actorId: owner.id });

    expect((await logsOf(org.id)).map((l) => l.metadata)).toEqual([
      { before: { name: 'Tên A' }, after: { name: 'Tên B' } },
    ]);
  });

  /**
   * Bảo đảm quan trọng nhất: thao tác quản trị KHÔNG THỂ thành công mà thiếu audit.
   * Ghi audit lỗi (ip sai định dạng → kiểu inet từ chối) → việc gỡ thành viên trước đó cũng rollback.
   */
  it('ghi audit lỗi → thao tác gỡ thành viên bị rollback theo (cùng transaction)', async () => {
    const { owner, target, org } = await setup();

    const error = await members
      .remove(org.id, target.id, { actorId: owner.id, ip: 'không-phải-ip' })
      .then(
        () => undefined,
        (e: unknown) => findPgError(e),
      );

    expect(error?.code).toBe('22P02');
    const still = await t.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, target.id)));
    expect(still).toHaveLength(1);
  });
});
