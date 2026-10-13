import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { organizations } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Organizations: tạo / xem / đổi tên + OrgMemberGuard (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());

  /** Owner + Admin + Member + người ngoài, dùng chung cho các test phân quyền. */
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);

    [owner, admin, member, outsider] = await Promise.all([
      registerUser(app, { displayName: 'Chủ' }),
      registerUser(app, { displayName: 'Quản trị' }),
      registerUser(app, { displayName: 'Thành viên' }),
      registerUser(app, { displayName: 'Người ngoài' }),
    ]);
    const created = await http()
      .post('/v1/orgs')
      .set(bearer(owner.tokens.accessToken))
      .send({ name: 'Bình Minh' })
      .expect(201);
    orgId = created.body.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (user: TestUser) => bearer(user.tokens.accessToken);

  describe('POST /v1/orgs', () => {
    it('201: người tạo là owner; tên được trim', async () => {
      const res = await http()
        .post('/v1/orgs')
        .set(as(outsider))
        .send({ name: '  Công ty Mới  ' })
        .expect(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'Công ty Mới',
        role: 'owner',
        joinedAt: expect.any(String),
      });
    });

    it.each([
      ['tên rỗng', { name: '   ' }],
      ['tên quá 100 ký tự', { name: 'x'.repeat(101) }],
    ])('%s → 400', async (_label, body) => {
      await http().post('/v1/orgs').set(as(owner)).send(body).expect(400);
    });

    it('không token → 401', async () => {
      await http().post('/v1/orgs').send({ name: 'A' }).expect(401);
    });
  });

  describe('GET /v1/orgs', () => {
    it('chỉ trả org của mình, kèm vai trò', async () => {
      const res = await http().get('/v1/orgs').set(as(member)).expect(200);
      expect(res.body).toEqual([expect.objectContaining({ id: orgId, role: 'member' })]);
    });
  });

  describe('GET /v1/orgs/:orgId', () => {
    it.each([
      ['owner', () => owner, 'owner'],
      ['admin', () => admin, 'admin'],
      ['member', () => member, 'member'],
    ])('%s → 200, myRole đúng, memberCount = 3', async (_label, who, myRole) => {
      const res = await http().get(`/v1/orgs/${orgId}`).set(as(who())).expect(200);
      expect(res.body).toMatchObject({ id: orgId, name: 'Bình Minh', myRole, memberCount: 3 });
    });

    it('người ngoài → 404 (không phải 403: không lộ org tồn tại)', async () => {
      const res = await http().get(`/v1/orgs/${orgId}`).set(as(outsider)).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ['không phải uuid (guard chặn trước khi xuống Postgres)', 'abc'],
      ['uuid không tồn tại', randomUUID()],
      ['chuỗi kiểu SQL injection', "1' or '1'='1"],
    ])('%s → 404, không phải 500', async (_label, id) => {
      await http()
        .get(`/v1/orgs/${encodeURIComponent(id)}`)
        .set(as(owner))
        .expect(404);
    });

    it('không token → 401 (guard toàn cục chạy trước OrgMemberGuard)', async () => {
      const res = await http().get(`/v1/orgs/${orgId}`).expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /v1/orgs/:orgId (org.update: Admin+)', () => {
    it.each([
      ['owner', () => owner, 200],
      ['admin', () => admin, 200],
      ['member', () => member, 403],
      ['người ngoài', () => outsider, 404],
    ])('%s → %i', async (_label, who, status) => {
      await http()
        .patch(`/v1/orgs/${orgId}`)
        .set(as(who()))
        .send({ name: 'Bình Minh' })
        .expect(status);
    });

    it('member bị 403 FORBIDDEN với body lỗi chuẩn', async () => {
      const res = await http()
        .patch(`/v1/orgs/${orgId}`)
        .set(as(member))
        .send({ name: 'Đổi lén' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  it('org đã xoá mềm → 404 với cả owner, và biến mất khỏi GET /v1/orgs', async () => {
    const created = await http()
      .post('/v1/orgs')
      .set(as(owner))
      .send({ name: 'Sắp xoá' })
      .expect(201);
    await db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, created.body.id));

    await http().get(`/v1/orgs/${created.body.id}`).set(as(owner)).expect(404);
    const mine = await http().get('/v1/orgs').set(as(owner)).expect(200);
    expect(mine.body.map((o: { id: string }) => o.id)).not.toContain(created.body.id);
  });
});
