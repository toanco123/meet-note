import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { createTestApp } from '../support/app.js';
import { addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Chuyển quyền sở hữu + rời tổ chức (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Org mới với owner + 1 admin + 1 member. */
  async function newOrg() {
    const [owner, admin, member] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    const orgId: string = (
      await http().post('/v1/orgs').set(as(owner)).send({ name: 'Chuyển giao' }).expect(201)
    ).body.data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
    return { owner, admin, member, orgId };
  }

  const myRole = async (u: TestUser, orgId: string) =>
    (await http().get(`/v1/orgs/${orgId}`).set(as(u)).expect(200)).body.data.myRole;

  describe('POST /v1/orgs/:orgId/ownership-transfer', () => {
    it('owner → member: người nhận thành owner, owner cũ thành admin và MẤT quyền owner ngay', async () => {
      const { owner, member, orgId } = await newOrg();

      const res = await http()
        .post(`/v1/orgs/${orgId}/ownership-transfer`)
        .set(as(owner))
        .send({ newOwnerId: member.id })
        .expect(200);

      expect(res.body.data).toEqual({ orgId, ownerId: member.id });
      expect(await myRole(member, orgId)).toBe('owner');
      expect(await myRole(owner, orgId)).toBe('admin');
      const again = await http()
        .post(`/v1/orgs/${orgId}/ownership-transfer`)
        .set(as(owner))
        .send({ newOwnerId: member.id })
        .expect(403);
      expect(again.body.error.code).toBe('FORBIDDEN');
    });

    it.each([
      ['admin gọi', 'admin', () => randomUUID(), 403, 'FORBIDDEN'],
      ['người nhận không phải thành viên', 'owner', () => randomUUID(), 404, 'NOT_FOUND'],
      ['chuyển cho chính mình', 'owner', null, 409, 'ORG_TRANSFER_INVALID_TARGET'],
    ] as const)('%s → %i %s', async (_label, callerRole, target, status, code) => {
      const org = await newOrg();
      const caller = callerRole === 'owner' ? org.owner : org.admin;
      const res = await http()
        .post(`/v1/orgs/${org.orgId}/ownership-transfer`)
        .set(as(caller))
        .send({ newOwnerId: target ? target() : caller.id })
        .expect(status);
      expect(res.body.error.code).toBe(code);
    });

    it('newOwnerId không phải uuid → 400', async () => {
      const { owner, orgId } = await newOrg();
      const res = await http()
        .post(`/v1/orgs/${orgId}/ownership-transfer`)
        .set(as(owner))
        .send({ newOwnerId: 'abc' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /v1/orgs/:orgId/leave', () => {
    it('member rời → 204, mất quyền ngay (404)', async () => {
      const { member, orgId } = await newOrg();
      expect((await http().post(`/v1/orgs/${orgId}/leave`).set(as(member))).status).toBe(204);
      await http().get(`/v1/orgs/${orgId}`).set(as(member)).expect(404);
    });

    it('owner rời → 409 ORG_OWNER_MUST_TRANSFER; chuyển quyền xong thì rời được', async () => {
      const { owner, admin, orgId } = await newOrg();
      const blocked = await http().post(`/v1/orgs/${orgId}/leave`).set(as(owner)).expect(409);
      expect(blocked.body.error.code).toBe('ORG_OWNER_MUST_TRANSFER');

      await http()
        .post(`/v1/orgs/${orgId}/ownership-transfer`)
        .set(as(owner))
        .send({ newOwnerId: admin.id })
        .expect(200);
      expect((await http().post(`/v1/orgs/${orgId}/leave`).set(as(owner))).status).toBe(204);
    });
  });
});
