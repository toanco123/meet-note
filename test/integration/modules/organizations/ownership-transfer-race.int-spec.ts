import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppException } from '../../../../src/common/errors/app.exception.js';
import { findPgError } from '../../../../src/common/errors/pg-error.js';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { organizationMembers } from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/organization-members.repository.js';
import { OrganizationMembersService } from '../../../../src/modules/organizations/organization-members.service.js';
import { addMember, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    const pg = findPgError(error);
    return pg ? `PG:${pg.code}` : ((error as AppException).code ?? String(error));
  }
}

/**
 * Owner chuyển quyền cho B ‖ cho C cùng lúc.
 * - Có khoá + kiểm tra lại: request sau thấy mình KHÔNG còn là owner → 403 FORBIDDEN (ngữ nghĩa đúng).
 * - Bỏ khoá: unique index "một owner" vẫn giữ dữ liệu đúng, nhưng request sau nhận 23505 (→ 409 chung
 *   chung). Constraint là lưới an toàn cuối; khoá cho ra lỗi có nghĩa.
 */
describe('Race: chuyển quyền sở hữu cho hai người cùng lúc (Postgres thật)', () => {
  let t: TestDb;
  let service: OrganizationMembersService;

  beforeAll(async () => {
    t = createTestDb(20);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationMembersService,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(OrganizationMembersService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('Owner → B ‖ Owner → C: [FORBIDDEN, OK] và đúng một owner (10 vòng)', async () => {
    for (let round = 0; round < 10; round++) {
      const owner = await insertUser(t.db);
      const [b, c] = [await insertUser(t.db), await insertUser(t.db)];
      const org = await insertOrg(t.db, owner.id);
      await addMember(t.db, org.id, b.id);
      await addMember(t.db, org.id, c.id);

      const outcomes = await Promise.all([
        outcomeOf(service.transferOwnership(org.id, b.id, { actorId: owner.id })),
        outcomeOf(service.transferOwnership(org.id, c.id, { actorId: owner.id })),
      ]);

      expect(outcomes.sort(), `vòng ${round}`).toEqual(['FORBIDDEN', 'OK']);
      const owners = await t.db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.role, 'owner')));
      expect(owners, `vòng ${round}`).toHaveLength(1);
    }
  });
});
