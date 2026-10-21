import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser } from '../../support/factories.js';

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
          statusCode: 404,
          message: expect.any(String),
          requestId: res.headers['x-request-id'],
        },
      });
    });
  });

  describe('Envelope { data, meta } cho response thành công', () => {
    const http = () => request(app.getHttpServer());

    it('một tài nguyên → đúng 2 khoá `data` + `meta`; meta.requestId trùng header x-request-id', async () => {
      const user = await registerUser(app);
      const res = await http().get('/v1/me').set(bearer(user.tokens.accessToken)).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['data', 'meta']);
      expect(res.body.data).toMatchObject({ id: user.id, email: user.email });
      expect(res.body.meta).toEqual({ statusCode: 200, requestId: res.headers['x-request-id'] });
    });

    it('client gửi x-request-id hợp lệ → được dùng lại ở header và meta', async () => {
      const user = await registerUser(app);
      const res = await http()
        .get('/v1/me')
        .set(bearer(user.tokens.accessToken))
        .set('x-request-id', 'trace-envelope-0001')
        .expect(200);
      expect([res.headers['x-request-id'], res.body.meta.requestId]).toEqual([
        'trace-envelope-0001',
        'trace-envelope-0001',
      ]);
    });

    it('danh sách → `data` là mảng thuần, `meta` có requestId + nextCursor', async () => {
      const user = await registerUser(app);
      const org = await http()
        .post('/v1/orgs')
        .set(bearer(user.tokens.accessToken))
        .send({ name: 'Envelope' })
        .expect(201);
      const res = await http()
        .get(`/v1/orgs/${org.body.data.id}/members`)
        .set(bearer(user.tokens.accessToken))
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toEqual({
        statusCode: 200,
        requestId: res.headers['x-request-id'],
        nextCursor: null,
      });
    });

    it('statusCode trong body luôn trùng HTTP status thật: tạo mới 201, lỗi 409', async () => {
      const user = await registerUser(app);
      const created = await http()
        .post('/v1/orgs')
        .set(bearer(user.tokens.accessToken))
        .send({ name: 'Status' })
        .expect(201);
      const conflict = await http()
        .post('/v1/auth/register')
        .send({ email: user.email, password: user.password, displayName: 'Trùng' })
        .expect(409);

      expect([created.body.meta.statusCode, conflict.body.error.statusCode]).toEqual([201, 409]);
    });

    it('204 → không có body; lỗi → chỉ có `error`; /health → body thô', async () => {
      const user = await registerUser(app);
      const logout = await http()
        .post('/v1/auth/logout')
        .set(bearer(user.tokens.accessToken))
        .expect(204);
      const notFound = await http().get('/v1/khong-ton-tai').expect(404);
      const health = await http().get('/health/live').expect(200);

      expect(logout.text).toBe('');
      expect(Object.keys(notFound.body)).toEqual(['error']);
      expect(health.body).toEqual({ status: 'ok' });
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

    it('f_unaccent bỏ dấu tiếng Việt, kể cả Đ/đ', async () => {
      const { rows } = await client.query<{ v: string }>(
        `select f_unaccent('Kế hoạch Quý IV ở Đà Nẵng, đầu tư') as v`,
      );
      expect(rows[0]?.v).toBe('Ke hoach Quy IV o Da Nang, dau tu');
    });

    it('f_unaccent còn chuẩn hoá một số dấu câu (gạch dài — thành -)', async () => {
      // unaccent.rules không chỉ bỏ dấu: nó map cả ký tự Unicode như "—", "…", "“" về ASCII.
      // Lợi cho search, nhưng đừng dùng f_unaccent để hiển thị lại văn bản cho người dùng.
      const { rows } = await client.query<{ v: string }>(
        `select f_unaccent('Quý IV — Đà Nẵng') as v`,
      );
      expect(rows[0]?.v).toBe('Quy IV - Da Nang');
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
