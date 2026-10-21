import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { sessions, users } from '../../../src/infra/database/schema/index.js';
import { REFRESH_TOKEN_PATTERN } from '../../../src/modules/auth/services/token.service.js';
import { createTestApp } from '../../support/app.js';
import { DEFAULT_PASSWORD, registerUser, uniqueEmail } from '../../support/factories.js';

describe('Auth: register + login (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /v1/auth/register', () => {
    it('201 + cặp token đầy đủ', async () => {
      const res = await http()
        .post('/v1/auth/register')
        .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD, displayName: '  Nguyễn An  ' })
        .expect(201);

      expect(res.body.data).toEqual({
        tokenType: 'Bearer',
        accessToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/),
        accessTokenExpiresAt: expect.any(String),
        refreshToken: expect.stringMatching(REFRESH_TOKEN_PATTERN),
        refreshTokenExpiresAt: expect.any(String),
      });
      expect(Date.parse(res.body.data.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    });

    it('lưu displayName đã trim, mật khẩu chỉ ở dạng argon2id', async () => {
      const email = uniqueEmail();
      await http()
        .post('/v1/auth/register')
        .send({ email, password: DEFAULT_PASSWORD, displayName: '  Trần Bình  ' })
        .expect(201);

      const [row] = await db.select().from(users).where(eq(users.email, email));
      expect(row?.displayName).toBe('Trần Bình');
      expect(row?.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(row?.passwordHash).not.toContain(DEFAULT_PASSWORD);
    });

    it('email trùng (khác hoa thường) → 409 AUTH_EMAIL_TAKEN', async () => {
      const user = await registerUser(app);

      const res = await http()
        .post('/v1/auth/register')
        .send({ email: user.email.toUpperCase(), password: DEFAULT_PASSWORD, displayName: 'B' })
        .expect(409);

      expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
    });

    it.each([
      ['mật khẩu 7 ký tự', { password: '1234567' }, 'password'],
      ['mật khẩu 129 ký tự (chặn DoS argon2)', { password: 'x'.repeat(129) }, 'password'],
      ['email sai định dạng', { email: 'not-an-email' }, 'email'],
      ['displayName rỗng sau khi trim', { displayName: '   ' }, 'displayName'],
      ['field thừa (forbidNonWhitelisted)', { role: 'admin' }, 'role'],
    ])('%s → 400 VALIDATION_FAILED', async (_label, patch, field) => {
      const res = await http()
        .post('/v1/auth/register')
        .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD, displayName: 'A', ...patch })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    });
  });

  describe('POST /v1/auth/login', () => {
    it('200 + cặp token; email không phân biệt hoa thường; lưu user-agent và ip của phiên', async () => {
      const user = await registerUser(app);

      const res = await http()
        .post('/v1/auth/login')
        .set('User-Agent', 'MeetNote-e2e/1.0')
        .send({ email: user.email.toUpperCase(), password: user.password })
        .expect(200);

      expect(res.body.data.tokenType).toBe('Bearer');
      const [row] = await db.select().from(users).where(eq(users.email, user.email));
      const userSessions = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, row?.id ?? ''));
      // 1 phiên từ register + 1 phiên từ login
      expect(userSessions).toHaveLength(2);
      expect(userSessions.some((s) => s.userAgent === 'MeetNote-e2e/1.0' && s.ip)).toBe(true);
    });

    it('sai mật khẩu và email không tồn tại → CÙNG 401, cùng message (không dò được email)', async () => {
      const user = await registerUser(app);

      const wrongPassword = await http()
        .post('/v1/auth/login')
        .send({ email: user.email, password: 'sai-mat-khau-roi' })
        .expect(401);
      const unknownEmail = await http()
        .post('/v1/auth/login')
        .send({ email: uniqueEmail('khong-ton-tai'), password: 'sai-mat-khau-roi' })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('hash cũ với tham số yếu → đăng nhập thành công rồi được băm lại theo tham số mới', async () => {
      const user = await registerUser(app);
      const weakHash = await argon2.hash(user.password, {
        type: argon2.argon2id,
        memoryCost: 8192,
        timeCost: 1,
        parallelism: 1,
      });
      await db.update(users).set({ passwordHash: weakHash }).where(eq(users.email, user.email));

      await http()
        .post('/v1/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);

      const [row] = await db.select().from(users).where(eq(users.email, user.email));
      expect(row?.passwordHash).not.toBe(weakHash);
      expect(row?.passwordHash).toContain('m=19456');
    });
  });
});
