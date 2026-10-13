import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppException } from '../../../../src/common/errors/app.exception.js';
import { generateOpaqueToken } from '../../../../src/common/crypto/opaque-token.js';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  organizationInvites,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { InviteAcceptanceService } from '../../../../src/modules/invites/invite-acceptance.service.js';
import { InvitesRepository } from '../../../../src/modules/invites/invites.repository.js';
import { JoinRequestsRepository } from '../../../../src/modules/invites/join-requests.repository.js';
import { OrganizationMembersRepository } from '../../../../src/modules/organizations/organization-members.repository.js';
import { insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return (
      (error as AppException).code ?? `PG:${(error as { cause?: { code?: string } }).cause?.code}`
    );
  }
}

/**
 * 30 người bấm link 10 lượt CÙNG LÚC → đúng 10 người vào, 20 người nhận 410 INVITE_EXHAUSTED.
 * Kỹ thuật: một câu UPDATE … WHERE use_count < max_uses — không SELECT … FOR UPDATE.
 */
describe('Race: chấp nhận link giới hạn lượt (Postgres thật)', () => {
  let t: TestDb;
  let service: InviteAcceptanceService;

  beforeAll(async () => {
    t = createTestDb(40);
    const moduleRef = await Test.createTestingModule({
      providers: [
        InviteAcceptanceService,
        InvitesRepository,
        JoinRequestsRepository,
        OrganizationMembersRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(InviteAcceptanceService);
  });

  afterAll(async () => {
    await t.close();
  });

  it('30 người ‖ link maxUses = 10 → đúng 10 OK, 20 INVITE_EXHAUSTED, use_count = 10', async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const { token, hash } = generateOpaqueToken();
    await t.db.insert(organizationInvites).values({
      orgId: org.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 3_600_000),
      maxUses: 10,
    });
    const guests = await Promise.all(Array.from({ length: 30 }, () => insertUser(t.db)));

    const outcomes = await Promise.all(
      guests.map((g) => outcomeOf(service.accept(token, { actorId: g.id }))),
    );

    const tally = outcomes.reduce<Record<string, number>>(
      (acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }),
      {},
    );
    expect(tally).toEqual({ OK: 10, INVITE_EXHAUSTED: 20 });
    const [invite] = await t.db
      .select({ useCount: organizationInvites.useCount })
      .from(organizationInvites)
      .where(eq(organizationInvites.tokenHash, hash));
    expect(invite?.useCount).toBe(10);
    const members = await t.db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, org.id));
    expect(members).toHaveLength(11); // owner + 10
  });
});
