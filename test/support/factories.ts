import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';

export const DEFAULT_PASSWORD = 'mat-khau-test-dai-du';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomBytes(5).toString('hex')}@example.com`;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  tokens: TokenPair;
}

/** Đăng ký qua HTTP thật (không chèn thẳng DB) để đi đúng đường của người dùng. */
export async function registerUser(
  app: INestApplication<App>,
  overrides: Partial<Pick<TestUser, 'email' | 'password' | 'displayName'>> = {},
): Promise<TestUser> {
  const input = {
    email: overrides.email ?? uniqueEmail(),
    password: overrides.password ?? DEFAULT_PASSWORD,
    displayName: overrides.displayName ?? 'Người dùng thử',
  };
  const res = await request(app.getHttpServer()).post('/v1/auth/register').send(input).expect(201);
  const tokens = res.body.data as TokenPair;
  const me = await request(app.getHttpServer())
    .get('/v1/me')
    .set(bearer(tokens.accessToken))
    .expect(200);
  return { ...input, id: (me.body.data as { id: string }).id, tokens };
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
