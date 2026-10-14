import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '../../src/common/crypto/opaque-token.js';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import {
  auditLogs,
  organizationInvites,
  organizations,
} from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Link mời: xem trước + chấp nhận (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let orgId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    owner = await registerUser(app);
    orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Nhận lời mời' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function newInvite(body: object = {}, org = orgId): Promise<string> {
    const res = await http()
      .post(`/v1/orgs/${org}/invites`)
      .set(bearer(owner.tokens.accessToken))
      .send(body)
      .expect(201);
    return res.body.token as string;
  }

  const useCountOf = async (token: string) =>
    (
      await db
        .select({ useCount: organizationInvites.useCount })
        .from(organizationInvites)
        .where(eq(organizationInvites.tokenHash, hashOpaqueToken(token)))
    )[0]?.useCount;

  const accept = (who: TestUser, token: string) =>
    http().post(`/v1/invites/${token}/accept`).set(bearer(who.tokens.accessToken));

  describe('GET /v1/invites/:token (public)', () => {
    it('không cần đăng nhập: trả tên org, vai trò, có cần duyệt không', async () => {
      const token = await newInvite({ role: 'admin' });
      const res = await http().get(`/v1/invites/${token}`).expect(200);
      expect(res.body).toMatchObject({
        orgName: 'Nhận lời mời',
        role: 'admin',
        requiresApproval: false,
      });
    });

    it.each([
      ['token sai định dạng', 'ngan-qua'],
      ['token đúng định dạng nhưng không tồn tại', 'A'.repeat(43)],
    ])('%s → 404 INVITE_NOT_FOUND', async (_label, token) => {
      const res = await http().get(`/v1/invites/${token}`).expect(404);
      expect(res.body.error.code).toBe('INVITE_NOT_FOUND');
    });

    it('đã thu hồi → 404; hết hạn → 410 INVITE_EXPIRED; hết lượt → 410 INVITE_EXHAUSTED', async () => {
      const revoked = await newInvite();
      await db
        .update(organizationInvites)
        .set({ revokedAt: new Date() })
        .where(eq(organizationInvites.tokenHash, hashOpaqueToken(revoked)));
      const expired = await newInvite();
      await db
        .update(organizationInvites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(organizationInvites.tokenHash, hashOpaqueToken(expired)));
      const exhausted = await newInvite({ maxUses: 1 });
      await accept(await registerUser(app), exhausted).expect(200);

      expect((await http().get(`/v1/invites/${revoked}`)).body.error.code).toBe('INVITE_NOT_FOUND');
      const exp = await http().get(`/v1/invites/${expired}`).expect(410);
      expect(exp.body.error.code).toBe('INVITE_EXPIRED');
      const exh = await http().get(`/v1/invites/${exhausted}`).expect(410);
      expect(exh.body.error.code).toBe('INVITE_EXHAUSTED');
    });
  });

  describe('POST /v1/invites/:token/accept', () => {
    it('vào thẳng với đúng vai trò của link, trừ 1 lượt, ghi audit org.member.joined', async () => {
      const token = await newInvite({ role: 'admin', maxUses: 3 });
      const guest = await registerUser(app);

      const res = await accept(guest, token).expect(200);

      expect(res.body).toEqual({ status: 'joined', orgId });
      const org = await http()
        .get(`/v1/orgs/${orgId}`)
        .set(bearer(guest.tokens.accessToken))
        .expect(200);
      expect(org.body.myRole).toBe('admin');
      expect(await useCountOf(token)).toBe(1);
      const logs = await db.select().from(auditLogs).where(eq(auditLogs.targetId, guest.id));
      expect(logs.map((l) => l.action)).toContain('org.member.joined');
    });

    it('đã là thành viên → 409 ORG_ALREADY_MEMBER và KHÔNG bị trừ lượt (transaction rollback)', async () => {
      const token = await newInvite({ maxUses: 5 });
      const guest = await registerUser(app);
      await accept(guest, token).expect(200);

      const again = await accept(guest, token).expect(409);

      expect(again.body.error.code).toBe('ORG_ALREADY_MEMBER');
      expect(await useCountOf(token)).toBe(1);
    });

    it('không đăng nhập → 401', async () => {
      const token = await newInvite();
      await http().post(`/v1/invites/${token}/accept`).expect(401);
      expect(await useCountOf(token)).toBe(0);
    });

    it('org cần duyệt → tạo yêu cầu pending (trừ lượt ngay, Q2), CHƯA là thành viên; gửi lại → 409', async () => {
      const { body: org } = await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Cần duyệt' })
        .expect(201);
      await db
        .update(organizations)
        .set({ requireJoinApproval: true })
        .where(eq(organizations.id, org.id));
      const token = await newInvite({ maxUses: 5 }, org.id);
      const guest = await registerUser(app);

      const res = await accept(guest, token).expect(200);

      expect(res.body).toEqual({ status: 'pending', orgId: org.id, requestId: expect.any(String) });
      await http().get(`/v1/orgs/${org.id}`).set(bearer(guest.tokens.accessToken)).expect(404);
      expect(await useCountOf(token)).toBe(1);
      const again = await accept(guest, token).expect(409);
      expect(again.body.error.code).toBe('ORG_JOIN_REQUEST_PENDING');
      expect(await useCountOf(token)).toBe(1);
    });

    it('link hết lượt → 410', async () => {
      const token = await newInvite({ maxUses: 1 });
      await accept(await registerUser(app), token).expect(200);
      const res = await accept(await registerUser(app), token).expect(410);
      expect(res.body.error.code).toBe('INVITE_EXHAUSTED');
    });
  });
});
