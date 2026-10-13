import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';

describe('Nền tảng (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Định dạng lỗi', () => {
    it('route không tồn tại → 404 với body lỗi chuẩn, requestId khớp header', async () => {
      const res = await request(app.getHttpServer()).get('/v1/khong-ton-tai').expect(404);

      expect(res.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: expect.any(String),
          requestId: res.headers['x-request-id'],
        },
      });
    });
  });

  describe('Swagger', () => {
    it('GET /docs-json trả tài liệu OpenAPI có tag và Bearer auth', async () => {
      const res = await request(app.getHttpServer()).get('/docs-json').expect(200);

      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.paths).toHaveProperty('/health/live');
      expect(res.body.components.securitySchemes).toHaveProperty('bearer');
      expect(res.body.tags.map((t: { name: string }) => t.name)).toContain('Organizations');
    });
  });

  describe('Migration 0000_extensions', () => {
    let client: Client;

    beforeAll(async () => {
      client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
    });

    it('f_unaccent bỏ dấu tiếng Việt', async () => {
      const { rows } = await client.query<{ v: string }>(
        `select f_unaccent('Kế hoạch Quý IV — Đà Nẵng') as v`,
      );
      expect(rows[0]?.v).toBe('Ke hoach Quy IV — Da Nang');
    });

    it('text search config meetnote_vi: tìm không dấu ra kết quả có dấu', async () => {
      const { rows } = await client.query<{ matched: boolean }>(
        `select to_tsvector('meetnote_vi', 'Chốt kế hoạch tuần sau')
                @@ websearch_to_tsquery('meetnote_vi', 'ke hoach') as matched`,
      );
      expect(rows[0]?.matched).toBe(true);
    });

    it('uuidv7() có sẵn (PostgreSQL 18)', async () => {
      const { rows } = await client.query<{ id: string }>(`select uuidv7()::text as id`);
      expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    });
  });
});
