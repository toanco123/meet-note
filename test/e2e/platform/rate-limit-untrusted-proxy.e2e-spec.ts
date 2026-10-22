import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../../support/app.js';
import { insertUser } from '../../support/db-factories.js';
import { fixtureDb } from '../../support/db.js';

// Bật rate limit, KHÔNG tin proxy (TRUST_PROXY_HOPS mặc định 0) — như api mở thẳng ra Internet.
vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = 'true';
});

describe('Rate limit khi không tin proxy (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // Đột biến: luôn bật `trust proxy` → mỗi lần đổi header là một "IP" mới → không bao giờ bị chặn.
  it('client tự đổi `X-Forwarded-For` mỗi lần → vẫn bị chặn ở lần 6 (IP thật của kết nối)', async () => {
    const { email } = await insertUser(fixtureDb());
    const results: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}`)
        .send({ email, password: 'sai-mat-khau-dai-du' });
      results.push(res.status);
    }
    expect(results).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
