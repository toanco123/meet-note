import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { createTestApp } from '../support/app.js';
import { addMember, insertUser } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('DELETE /v1/orgs/:orgId/members/:userId — gỡ thành viên (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, admin, member] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Gỡ thành viên' })
        .expect(201)
    ).body.data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  async function newTarget(role: 'admin' | 'member'): Promise<string> {
    const user = await insertUser(db);
    await addMember(db, orgId, user.id, role);
    return user.id;
  }

  const remove = (who: TestUser, userId: string) =>
    http().delete(`/v1/orgs/${orgId}/members/${userId}`).set(bearer(who.tokens.accessToken));

  it.each([
    ['owner gỡ admin', () => owner, 'admin'],
    ['owner gỡ member', () => owner, 'member'],
    ['admin gỡ member', () => admin, 'member'],
  ] as const)('%s → 204', async (_label, who, targetRole) => {
    const target = await newTarget(targetRole);
    const res = await remove(who(), target);
    expect(res.status).toBe(204);
  });

  it.each([
    ['admin gỡ admin khác', () => admin, 'admin', 403, 'FORBIDDEN'],
    ['member gỡ member', () => member, 'member', 403, 'FORBIDDEN'],
  ] as const)('%s → %i %s', async (_label, who, targetRole, status, code) => {
    const res = await remove(who(), await newTarget(targetRole)).expect(status);
    expect(res.body.error.code).toBe(code);
  });

  it.each([
    ['admin gỡ owner', () => admin],
    ['owner tự gỡ mình (phải chuyển quyền sở hữu trước)', () => owner],
  ])('%s → 409 ORG_OWNER_IMMUTABLE', async (_label, who) => {
    const res = await remove(who(), owner.id).expect(409);
    expect(res.body.error.code).toBe('ORG_OWNER_IMMUTABLE');
  });

  it('admin tự gỡ mình → 403 (rời tổ chức là chức năng riêng, M3)', async () => {
    const res = await remove(admin, admin.id).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('người bị gỡ mất quyền NGAY: gọi lại org → 404, org biến mất khỏi danh sách của họ', async () => {
    const victim = await registerUser(app);
    await addMember(db, orgId, victim.id, 'member');
    await http().get(`/v1/orgs/${orgId}`).set(bearer(victim.tokens.accessToken)).expect(200);

    await remove(owner, victim.id).expect(204);

    await http().get(`/v1/orgs/${orgId}`).set(bearer(victim.tokens.accessToken)).expect(404);
    const mine = await http().get('/v1/orgs').set(bearer(victim.tokens.accessToken)).expect(200);
    expect(mine.body.data).toEqual([]);
  });

  it('gỡ lần hai cùng người → 404', async () => {
    const target = await newTarget('member');
    await remove(owner, target).expect(204);
    const res = await remove(owner, target).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
