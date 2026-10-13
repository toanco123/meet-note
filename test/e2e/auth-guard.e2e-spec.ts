import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../../src/common/auth/auth-user.js';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { sessions } from '../../src/infra/database/schema/index.js';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../src/modules/auth/token.service.js';
import { createTestApp } from '../support/app.js';
import { bearer, registerUser } from '../support/factories.js';
import { ProbeController } from '../support/probe.controller.js';

describe('JwtAuthGuard toàn cục (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());

  /** Ký token bằng đúng secret của app trong test, để tạo các ca "xấu" có chủ đích. */
  const signRaw = (payload: object, options: object = {}) =>
    new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).signAsync(payload, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ...options,
    });

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('token hợp lệ → 200, @CurrentUser nhận { id, sessionId } từ JWT', async () => {
    const user = await registerUser(app);

    const res = await http()
      .get('/v1/__probe/private')
      .set(bearer(user.tokens.accessToken))
      .expect(200);

    expect(res.body).toEqual({ id: expect.any(String), sessionId: expect.any(String) });
  });

  it('route @Public() không cần token', async () => {
    await http().get('/v1/__probe/public').expect(200, { ok: true });
  });

  it('route không đánh dấu @Public() mặc định bị chặn (mặc định đóng)', async () => {
    const res = await http().get('/v1/__probe/private').expect(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
  });

  it.each([
    ['sai scheme (Basic)', 'Basic abc'],
    ['thiếu token sau Bearer', 'Bearer '],
  ])('Authorization %s → 401 AUTH_TOKEN_MISSING', async (_label, header) => {
    const res = await http().get('/v1/__probe/private').set('Authorization', header).expect(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
  });

  it('token rác → 401 AUTH_TOKEN_INVALID', async () => {
    const res = await http().get('/v1/__probe/private').set(bearer('abc.def.ghi')).expect(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('token hết hạn (chữ ký đúng) → 401 AUTH_TOKEN_EXPIRED', async () => {
    const user = await registerUser(app);
    const { sessionId, id } = (
      await http().get('/v1/__probe/private').set(bearer(user.tokens.accessToken))
    ).body as AuthUser;
    const expired = await signRaw(
      { sid: sessionId, exp: Math.floor(Date.now() / 1000) - 5 },
      { subject: id },
    );

    const res = await http().get('/v1/__probe/private').set(bearer(expired)).expect(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('phiên đã thu hồi → access token còn hạn vẫn bị 401 AUTH_SESSION_REVOKED (Q1)', async () => {
    const user = await registerUser(app);
    const { sessionId } = (
      await http().get('/v1/__probe/private').set(bearer(user.tokens.accessToken))
    ).body as AuthUser;

    await db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(eq(sessions.id, sessionId));

    const res = await http()
      .get('/v1/__probe/private')
      .set(bearer(user.tokens.accessToken))
      .expect(401);
    expect(res.body.error.code).toBe('AUTH_SESSION_REVOKED');
  });

  it('health vẫn public sau khi bật guard toàn cục', async () => {
    await http().get('/health/live').expect(200);
  });

  describe('Swagger', () => {
    it('mặc định yêu cầu Bearer; route @Public() có security [{}]', async () => {
      const doc = (await http().get('/docs-json').expect(200)).body;

      expect(doc.security).toEqual([{ bearer: [] }]);
      expect(doc.paths['/v1/auth/login'].post.security).toEqual([{}]);
      expect(doc.paths['/health/live'].get.security).toEqual([{}]);
      expect(doc.paths['/v1/__probe/private'].get.security).toBeUndefined(); // thừa hưởng mặc định
    });
  });
});
