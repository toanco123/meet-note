import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { createTestApp } from '../../support/app.js';
import { addMember, insertUser } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

describe('PATCH /v1/orgs/:orgId/members/:userId — đổi vai trò (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, admin, member, outsider] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Vai trò' })
        .expect(201)
    ).body.data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  /** Mỗi ca đổi vai trò dùng một "nạn nhân" mới để các ca không ảnh hưởng nhau. */
  async function newTarget(role: 'admin' | 'member'): Promise<string> {
    const user = await insertUser(db);
    await addMember(db, orgId, user.id, role);
    return user.id;
  }

  const patch = (who: TestUser, userId: string, role: string) =>
    http()
      .patch(`/v1/orgs/${orgId}/members/${userId}`)
      .set(bearer(who.tokens.accessToken))
      .send({ role });

  it.each([
    ['owner nâng member → admin', 'member', 'admin'],
    ['owner hạ admin → member', 'admin', 'member'],
  ] as const)('%s → 200', async (_label, from, to) => {
    const target = await newTarget(from);
    const res = await patch(owner, target, to).expect(200);
    expect(res.body.data).toMatchObject({ userId: target, role: to });
  });

  it.each([
    ['admin nâng member → admin', () => admin, 'member', 'admin', 403, 'FORBIDDEN'],
    ['admin hạ admin khác → member', () => admin, 'admin', 'member', 403, 'FORBIDDEN'],
    ['member nâng member → admin', () => member, 'member', 'admin', 403, 'FORBIDDEN'],
    ['người ngoài', () => outsider, 'member', 'admin', 404, 'NOT_FOUND'],
  ] as const)('%s → %i %s', async (_label, who, from, to, status, code) => {
    const res = await patch(who(), await newTarget(from), to).expect(status);
    expect(res.body.error.code).toBe(code);
  });

  it('đổi vai trò của Owner (kể cả Owner tự đổi) → 409 ORG_OWNER_IMMUTABLE', async () => {
    const res = await patch(owner, owner.id, 'member').expect(409);
    expect(res.body.error.code).toBe('ORG_OWNER_IMMUTABLE');
  });

  it("role 'owner' không gán được qua API → 400 (phải chuyển quyền sở hữu)", async () => {
    const res = await patch(owner, await newTarget('member'), 'owner').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('người không thuộc org → 404', async () => {
    const res = await patch(owner, outsider.id, 'admin').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('userId không tồn tại → 404; userId không phải uuid → 400', async () => {
    await patch(owner, randomUUID(), 'admin').expect(404);
    const bad = await patch(owner, 'abc', 'admin').expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('vai trò mới có hiệu lực ngay ở request kế tiếp (guard đọc membership mỗi request)', async () => {
    const promoted = await registerUser(app);
    await addMember(db, orgId, promoted.id, 'member');
    const rename = () =>
      http()
        .patch(`/v1/orgs/${orgId}`)
        .set(bearer(promoted.tokens.accessToken))
        .send({ name: 'Vai trò' });

    expect((await rename()).status).toBe(403);
    await patch(owner, promoted.id, 'admin').expect(200);
    expect((await rename()).status).toBe(200); // cùng access token, không cần đăng nhập lại
  });
});
