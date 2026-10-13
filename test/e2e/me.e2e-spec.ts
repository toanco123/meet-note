import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';
import { bearer, registerUser, type TestUser, type TokenPair } from '../support/factories.js';

interface SessionBody {
  id: string;
  current: boolean;
  userAgent: string | null;
}

describe('Me: /v1/me và /v1/me/sessions (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginAgain(user: TestUser, userAgent: string): Promise<TokenPair> {
    const res = await http()
      .post('/v1/auth/login')
      .set('User-Agent', userAgent)
      .send({ email: user.email, password: user.password })
      .expect(200);
    return res.body as TokenPair;
  }

  const sessionsOf = async (accessToken: string) =>
    (await http().get('/v1/me/sessions').set(bearer(accessToken)).expect(200))
      .body as SessionBody[];

  describe('GET /v1/me', () => {
    it('trả hồ sơ, KHÔNG có passwordHash', async () => {
      const user = await registerUser(app, { displayName: 'Phạm Thu' });

      const res = await http().get('/v1/me').set(bearer(user.tokens.accessToken)).expect(200);

      expect(res.body).toEqual({
        id: expect.any(String),
        email: user.email,
        displayName: 'Phạm Thu',
        createdAt: expect.any(String),
        organizations: [],
      });
      expect(JSON.stringify(res.body)).not.toContain('argon2');
    });

    it('có danh sách org của tôi kèm vai trò, theo thứ tự tham gia (M2)', async () => {
      const user = await registerUser(app);
      for (const name of ['Org A', 'Org B']) {
        await http()
          .post('/v1/orgs')
          .set(bearer(user.tokens.accessToken))
          .send({ name })
          .expect(201);
      }

      const res = await http().get('/v1/me').set(bearer(user.tokens.accessToken)).expect(200);

      expect(res.body.organizations).toEqual([
        { id: expect.any(String), name: 'Org A', role: 'owner' },
        { id: expect.any(String), name: 'Org B', role: 'owner' },
      ]);
    });

    it('không có token → 401', async () => {
      const res = await http().get('/v1/me').expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /v1/me', () => {
    it('đổi displayName (đã trim)', async () => {
      const user = await registerUser(app);

      const res = await http()
        .patch('/v1/me')
        .set(bearer(user.tokens.accessToken))
        .send({ displayName: '  Lê Văn Cường  ' })
        .expect(200);

      expect(res.body.displayName).toBe('Lê Văn Cường');
    });

    it.each([
      ['displayName rỗng', { displayName: '   ' }],
      ['cố đổi email qua PATCH (field không cho phép)', { displayName: 'A', email: 'x@y.com' }],
    ])('%s → 400', async (_label, body) => {
      const user = await registerUser(app);
      const res = await http()
        .patch('/v1/me')
        .set(bearer(user.tokens.accessToken))
        .send(body)
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /v1/me/sessions', () => {
    it('liệt kê phiên còn sống, đúng một phiên có current = true', async () => {
      const user = await registerUser(app);
      const laptop = await loginAgain(user, 'Laptop/1.0');

      const list = await sessionsOf(laptop.accessToken);

      expect(list).toHaveLength(2);
      expect(list.filter((s) => s.current)).toHaveLength(1);
      expect(list.find((s) => s.current)?.userAgent).toBe('Laptop/1.0');
    });

    it('phiên đã logout không còn trong danh sách', async () => {
      const user = await registerUser(app);
      const laptop = await loginAgain(user, 'Laptop/1.0');

      await http().post('/v1/auth/logout').set(bearer(laptop.accessToken)).expect(204);

      expect(await sessionsOf(user.tokens.accessToken)).toHaveLength(1);
    });
  });

  describe('DELETE /v1/me/sessions/:sessionId', () => {
    it('thu hồi thiết bị khác → 204, thiết bị đó bị 401 ngay, phiên hiện tại vẫn sống', async () => {
      const user = await registerUser(app);
      const laptop = await loginAgain(user, 'Laptop/1.0');
      const laptopSession = (await sessionsOf(laptop.accessToken)).find((s) => s.current);

      await http()
        .delete(`/v1/me/sessions/${laptopSession?.id}`)
        .set(bearer(user.tokens.accessToken))
        .expect(204);

      expect(
        (await http().get('/v1/me').set(bearer(laptop.accessToken)).expect(401)).body.error.code,
      ).toBe('AUTH_SESSION_REVOKED');
      await http().get('/v1/me').set(bearer(user.tokens.accessToken)).expect(200);
    });

    it('phiên của người khác → 404 (không lộ là phiên đó tồn tại), và phiên đó không bị ảnh hưởng', async () => {
      const victim = await registerUser(app);
      const attacker = await registerUser(app);
      const victimSession = (await sessionsOf(victim.tokens.accessToken))[0];

      const res = await http()
        .delete(`/v1/me/sessions/${victimSession?.id}`)
        .set(bearer(attacker.tokens.accessToken))
        .expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      await http().get('/v1/me').set(bearer(victim.tokens.accessToken)).expect(200);
    });

    it('id không tồn tại → 404; id không phải uuid → 400', async () => {
      const user = await registerUser(app);

      await http()
        .delete(`/v1/me/sessions/${randomUUID()}`)
        .set(bearer(user.tokens.accessToken))
        .expect(404);
      const bad = await http()
        .delete('/v1/me/sessions/abc')
        .set(bearer(user.tokens.accessToken))
        .expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
