import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppException } from '../../../../src/common/errors/app.exception.js';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  auditLogs,
  organizationJoinRequests,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { JoinRequestsRepository } from '../../../../src/modules/invites/join-requests.repository.js';
import { JoinRequestsService } from '../../../../src/modules/invites/join-requests.service.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/organization-members.repository.js';
import { addMember, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (error as AppException).code ?? String(error);
  }
}

/** 2 Admin bấm duyệt CÙNG một yêu cầu cùng lúc → đúng 1 lần duyệt, 1 dòng audit. */
describe('Race: hai Admin duyệt cùng một yêu cầu (Postgres thật)', () => {
  let t: TestDb;
  let service: JoinRequestsService;

  beforeAll(async () => {
    t = createTestDb(20);
    const moduleRef = await Test.createTestingModule({
      providers: [
        JoinRequestsService,
        JoinRequestsRepository,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(JoinRequestsService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('Admin A ‖ Admin B duyệt cùng yêu cầu → [OK, JOIN_REQUEST_NOT_PENDING], 1 audit (10 vòng)', async () => {
    const owner = await insertUser(t.db);
    const [a, b] = [await insertUser(t.db), await insertUser(t.db)];
    const org = await insertOrg(t.db, owner.id);
    await addMember(t.db, org.id, a.id, 'admin');
    await addMember(t.db, org.id, b.id, 'admin');

    for (let round = 0; round < 10; round++) {
      const guest = await insertUser(t.db);
      const [req] = await t.db
        .insert(organizationJoinRequests)
        .values({ orgId: org.id, userId: guest.id, role: 'member' })
        .returning();
      const requestId = req?.id ?? '';

      const outcomes = await Promise.all([
        outcomeOf(service.approve(org.id, requestId, { actorId: a.id })),
        outcomeOf(service.approve(org.id, requestId, { actorId: b.id })),
      ]);

      expect(outcomes.sort(), `vòng ${round}`).toEqual(['JOIN_REQUEST_NOT_PENDING', 'OK']);
      const logs = await t.db.select().from(auditLogs).where(eq(auditLogs.targetId, requestId));
      expect(logs, `vòng ${round}: đúng 1 dòng audit`).toHaveLength(1);
    }
  });
});
