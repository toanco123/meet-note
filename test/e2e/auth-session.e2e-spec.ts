import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { refreshTokens } from '../../src/infra/database/schema/index.js';
import { hashRefreshToken } from '../../src/modules/auth/services/token.service.js';
import { createTestApp } from '../support/app.js';
import { bearer, registerUser, type TokenPair } from '../support/factories.js';
import { ProbeController } from '../support/probe.controller.js';

describe('Auth: refresh, logout, logout-all (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  const refresh = (refreshToken: string) => http().post('/v1/auth/refresh').send({ refreshToken });
  const probe = (accessToken: string) => http().get('/v1/__probe/private').set(bearer(accessToken));

  /** Giả lập "token đã xoay từ 1 phút trước" (quá grace 10s) mà không phải chờ. */
  async function ageRotation(refreshToken: string) {
    await db
      .update(refreshTokens)
      .set({ rotatedAt: sql`rotated_at - interval '1 minute'` })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
  }

  describe('POST /v1/auth/refresh', () => {
    it('luồng đầy đủ: refresh → token mới dùng được → dùng lại token cũ quá grace → phiên bị thu hồi', async () => {
      const user = await registerUser(app);

      // 1. refresh → cặp token mới, access mới gọi được route cần đăng nhập
      const rotated = (await refresh(user.tokens.refreshToken).expect(200)).body as TokenPair;
      expect(rotated.refreshToken).not.toBe(user.tokens.refreshToken);
      await probe(rotated.accessToken).expect(200);

      // 2. kẻ trộm dùng lại refresh token cũ (quá grace) → REUSED
      await ageRotation(user.tokens.refreshToken);
      const reused = await refresh(user.tokens.refreshToken).expect(401);
      expect(reused.body.error.code).toBe('AUTH_REFRESH_TOKEN_REUSED');

      // 3. cả phiên chết: access token còn hạn cũng bị từ chối, refresh token mới nhất cũng vô dụng
      expect((await probe(rotated.accessToken).expect(401)).body.error.code).toBe(
        'AUTH_SESSION_REVOKED',
      );
      expect((await refresh(rotated.refreshToken).expect(401)).body.error.code).toBe(
        'AUTH_REFRESH_TOKEN_INVALID',
      );
    });

    it('dùng lại token cũ TRONG grace (2 tab) → 401 ROTATED, phiên vẫn sống', async () => {
      const user = await registerUser(app);
      const rotated = (await refresh(user.tokens.refreshToken).expect(200)).body as TokenPair;

      const second = await refresh(user.tokens.refreshToken).expect(401);

      expect(second.body.error.code).toBe('AUTH_REFRESH_TOKEN_ROTATED');
      await probe(rotated.accessToken).expect(200);
    });

    it('token đúng định dạng nhưng không tồn tại → 401 INVALID', async () => {
      const res = await refresh(randomBytes(32).toString('base64url')).expect(401);
      expect(res.body.error.code).toBe('AUTH_REFRESH_TOKEN_INVALID');
    });

    it('token sai định dạng → 400 trước khi chạm DB', async () => {
      const res = await refresh('ngan-qua').expect(400);
      expect(res.body.error.details[0].field).toBe('refreshToken');
    });

    it('không cần access token (route @Public)', async () => {
      const user = await registerUser(app);
      const res = await refresh(user.tokens.refreshToken).expect(200);
      expect(res.body.tokenType).toBe('Bearer');
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('204 → access token của phiên bị từ chối ngay, refresh token không dùng được', async () => {
      const user = await registerUser(app);

      await http().post('/v1/auth/logout').set(bearer(user.tokens.accessToken)).expect(204);

      expect((await probe(user.tokens.accessToken).expect(401)).body.error.code).toBe(
        'AUTH_SESSION_REVOKED',
      );
      expect((await refresh(user.tokens.refreshToken).expect(401)).body.error.code).toBe(
        'AUTH_REFRESH_TOKEN_INVALID',
      );
    });

    it('chỉ đăng xuất phiên hiện tại, phiên khác của cùng user vẫn sống', async () => {
      const user = await registerUser(app);
      const otherDevice = (
        await http()
          .post('/v1/auth/login')
          .send({ email: user.email, password: user.password })
          .expect(200)
      ).body as TokenPair;

      await http().post('/v1/auth/logout').set(bearer(user.tokens.accessToken)).expect(204);

      await probe(otherDevice.accessToken).expect(200);
    });

    it('không có token → 401 AUTH_TOKEN_MISSING', async () => {
      const res = await http().post('/v1/auth/logout').expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
    });
  });

  describe('POST /v1/auth/logout-all', () => {
    it('thu hồi mọi phiên của user, không đụng tới user khác', async () => {
      const user = await registerUser(app);
      const otherDevice = (
        await http()
          .post('/v1/auth/login')
          .send({ email: user.email, password: user.password })
          .expect(200)
      ).body as TokenPair;
      const bystander = await registerUser(app);

      await http().post('/v1/auth/logout-all').set(bearer(user.tokens.accessToken)).expect(204);

      await probe(user.tokens.accessToken).expect(401);
      await probe(otherDevice.accessToken).expect(401);
      await probe(bystander.tokens.accessToken).expect(200);
    });
  });
});
