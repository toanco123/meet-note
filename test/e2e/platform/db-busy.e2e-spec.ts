import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser } from '../../support/factories.js';

/**
 * Cấu hình timeout MẶC ĐỊNH của app (`lock_timeout` 3 s) đi tới tận HTTP: một transaction khác giữ
 * khoá dòng tổ chức → sửa tổ chức trả 503 + `Retry-After` sau ~3 s, không treo (M11 B1).
 */
describe('DB bận → 503 (e2e)', () => {
  let app: INestApplication<App>;
  let holder: Pool;

  beforeAll(async () => {
    app = await createTestApp();
    holder = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  });

  afterAll(async () => {
    await holder.end();
    await app.close();
  });

  it('dòng tổ chức bị khoá lâu hơn lock_timeout → 503 SERVICE_UNAVAILABLE + Retry-After, rồi thử lại được', async () => {
    const owner = await registerUser(app);
    const orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Bận' })
        .expect(201)
    ).body.data.id as string;
    const client = await holder.connect();
    await client.query('begin');
    await client.query('select 1 from organizations where id = $1 for update', [orgId]);
    const rename = () =>
      request(app.getHttpServer())
        .patch(`/v1/orgs/${orgId}`)
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Đổi tên' });

    const started = Date.now();
    const busy = await rename();
    const waited = Date.now() - started;
    await client.query('rollback');
    client.release();

    expect([busy.status, busy.headers['retry-after'], busy.body.error.code]).toEqual([
      503,
      '1',
      'SERVICE_UNAVAILABLE',
    ]);
    expect(waited).toBeGreaterThanOrEqual(2_900);
    expect(waited).toBeLessThan(6_000);
    expect((await rename()).status).toBe(200);
  });
});
