import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { auditLogs } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

interface InviteBody {
  id: string;
  role: string;
  status: string;
  token?: string;
  createdAt: string;
}

describe('Link mời: tạo / liệt kê / thu hồi (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());
  const create = (who: TestUser, body: object = {}, org = orgId) =>
    http().post(`/v1/orgs/${org}/invites`).set(bearer(who.tokens.accessToken)).send(body);

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
        .send({ name: 'Mời' })
        .expect(201)
    ).body.data.id;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/orgs/:orgId/invites', () => {
    it('owner tạo link admin → 201, có token (43 ký tự) đúng một lần, mặc định 7 ngày', async () => {
      const res = await create(owner, { role: 'admin', maxUses: 5 }).expect(201);
      const body = res.body.data as InviteBody & {
        expiresAt: string;
        maxUses: number;
        useCount: number;
      };

      expect(body).toMatchObject({ role: 'admin', status: 'active', maxUses: 5, useCount: 0 });
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7);
    });

    it.each([
      ['admin tạo link member', () => admin, { role: 'member' }, 201],
      ['admin tạo link admin (cấp vai trò ngang mình)', () => admin, { role: 'admin' }, 403],
      ['member tạo link', () => member, {}, 403],
      ['người ngoài', () => outsider, {}, 404],
    ] as const)('%s → %i', async (_label, who, body, status) => {
      const res = await create(who(), body);
      expect(res.status).toBe(status);
    });

    it.each([
      ['expiresInHours = 0', { expiresInHours: 0 }],
      ['expiresInHours > 720', { expiresInHours: 721 }],
      ['maxUses = 0', { maxUses: 0 }],
      ["role 'owner'", { role: 'owner' }],
    ])('%s → 400', async (_label, body) => {
      const res = await create(owner, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('audit ghi org.invite.created, KHÔNG chứa token', async () => {
      const res = await create(owner, { maxUses: 3 }).expect(201);
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.targetId, res.body.data.id));

      expect(log).toMatchObject({ action: 'org.invite.created', actorId: owner.id });
      expect(JSON.stringify(log)).not.toContain(res.body.data.token);
    });
  });

  describe('GET /v1/orgs/:orgId/invites', () => {
    it('phân trang mới nhất trước: không trùng, không sót, giảm dần, không có token', async () => {
      const {
        body: { data: fresh },
      } = await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Nhiều link' })
        .expect(201);
      for (let i = 0; i < 12; i++) await create(owner, {}, fresh.id).expect(201);

      const seen: InviteBody[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { data: InviteBody[]; meta: { nextCursor: string | null } } } =
          await http()
            .get(`/v1/orgs/${fresh.id}/invites`)
            .query(cursor ? { limit: 5, cursor } : { limit: 5 })
            .set(bearer(owner.tokens.accessToken))
            .expect(200);
        seen.push(...res.body.data);
        cursor = res.body.meta.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(12);
      expect(new Set(seen.map((i) => i.id)).size).toBe(12);
      const times = seen.map((i) => Date.parse(i.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(seen.some((i) => 'token' in i)).toBe(false);
    });

    it('member → 403', async () => {
      const res = await http()
        .get(`/v1/orgs/${orgId}/invites`)
        .set(bearer(member.tokens.accessToken))
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('DELETE /v1/orgs/:orgId/invites/:inviteId', () => {
    it('thu hồi → 204, trạng thái revoked; thu hồi lần hai vẫn 204 (idempotent, chỉ 1 audit)', async () => {
      const { data: body } = (await create(owner).expect(201)).body;
      const revoke = () =>
        http().delete(`/v1/orgs/${orgId}/invites/${body.id}`).set(bearer(admin.tokens.accessToken));

      expect((await revoke()).status).toBe(204);
      expect((await revoke()).status).toBe(204);

      const list = await http()
        .get(`/v1/orgs/${orgId}/invites`)
        .query({ limit: 100 })
        .set(bearer(owner.tokens.accessToken))
        .expect(200);
      expect(list.body.data.find((i: InviteBody) => i.id === body.id)?.status).toBe('revoked');
      const logs = await db.select().from(auditLogs).where(eq(auditLogs.targetId, body.id));
      expect(logs.map((l) => l.action).sort()).toEqual([
        'org.invite.created',
        'org.invite.revoked',
      ]);
    });

    it('link của org khác / không tồn tại → 404', async () => {
      const res = await http()
        .delete(`/v1/orgs/${orgId}/invites/${randomUUID()}`)
        .set(bearer(owner.tokens.accessToken))
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
