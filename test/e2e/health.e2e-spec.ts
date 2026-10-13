import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live → 200', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health/ready → 200 khi Postgres và Redis đều sống', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  describe('x-request-id', () => {
    it('tự sinh khi client không gửi', async () => {
      const res = await request(app.getHttpServer()).get('/health/live');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('giữ nguyên giá trị hợp lệ từ client/proxy', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('x-request-id', 'trace-abc-12345');
      expect(res.headers['x-request-id']).toBe('trace-abc-12345');
    });

    it('bỏ qua giá trị không hợp lệ (chống log injection)', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .set('x-request-id', 'bad id with spaces');
      expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
    });
  });
});
