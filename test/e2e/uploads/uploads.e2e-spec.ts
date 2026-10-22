import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { uploads } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addMember, insertMeeting } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { createTestStorage, isMultipartAlive } from '../../support/storage.js';
import { fixtureDb } from '../../support/db.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('Upload: khởi tạo / trạng thái / huỷ (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let stranger: TestUser;
  let orgId: string;
  const s3 = createTestStorage();

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const base = () => `/v1/orgs/${orgId}/uploads`;
  const valid = {
    filename: '  giao-ban.m4a  ',
    mimeType: 'audio/mp4',
    sizeBytes: 20 * MiB,
    sha256: 'AB'.repeat(32),
    title: 'Giao ban kỹ thuật',
    recordedAt: '2026-10-19T02:00:00.000Z',
  };
  const init = (who: TestUser, body: object = {}) =>
    http()
      .post(base())
      .set(as(who))
      .send({ ...valid, ...body });
  const rowOf = async (id: string) =>
    (await db.select().from(uploads).where(eq(uploads.id, id)))[0];
  const multipartAlive = async (id: string) => {
    const row = await rowOf(id);
    if (!row) throw new Error('không có upload');
    return isMultipartAlive(s3.storage, row.objectKey, row.s3UploadId);
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    [owner, orgAdmin, alice, bob, stranger] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Upload' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    await addMember(db, orgId, alice.id, 'member');
    await addMember(db, orgId, bob.id, 'member');
  });

  afterAll(async () => {
    s3.close();
    await app.close();
  });

  describe('POST …/uploads', () => {
    it('201: 8 MiB / phần, 20 MiB → 3 phần, hạn 24 giờ; sha256 hạ chữ thường; multipart đã mở trên S3', async () => {
      const res = await init(alice).expect(201);
      const body = res.body.data;

      expect(body).toMatchObject({
        status: 'initiated',
        filename: 'giao-ban.m4a',
        chunkSize: 8 * MiB,
        totalParts: 3,
        receivedParts: [],
        meetingId: null,
      });
      const hours = (Date.parse(body.expiresAt) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
      const row = await rowOf(body.id);
      expect(row?.sha256).toBe('ab'.repeat(32));
      expect(row?.objectKey).toBe(`orgs/${orgId}/uploads/${body.id}/source`);
      expect(await multipartAlive(body.id)).toBe(true);
    });

    it.each([
      ['đúng 2 GiB → 256 phần', 2 * GiB, 256],
      ['1 byte → 1 phần', 1, 1],
      ['8 MiB + 1 byte → 2 phần', 8 * MiB + 1, 2],
    ])('%s', async (_label, sizeBytes, totalParts) => {
      const res = await init(alice, { sizeBytes }).expect(201);
      expect(res.body.data.totalParts).toBe(totalParts);
    });

    it.each([
      ['0 byte', { sizeBytes: 0 }],
      ['quá 2 GiB', { sizeBytes: 2 * GiB + 1 }],
      ['kích thước không nguyên', { sizeBytes: 1.5 }],
      ['mime không cho phép', { mimeType: 'image/png' }],
      ['sha256 sai', { sha256: 'xyz' }],
      ['tiêu đề rỗng', { title: '   ' }],
      ['recordedAt không phải ISO', { recordedAt: 'hôm qua' }],
      ['field thừa', { s3UploadId: 'tự-đặt' }],
    ])('%s → 400', async (_label, body) => {
      const res = await init(alice, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('người ngoài tổ chức → 404', async () => {
      const res = await init(stranger);
      expect(res.status).toBe(404);
    });
  });

  describe('GET …/uploads/:uploadId', () => {
    it('người tạo xem được; người khác (kể cả Admin, Owner org) → 404 như không tồn tại', async () => {
      const { id } = (await init(alice).expect(201)).body.data;
      const get = (who: TestUser, uploadId = id) =>
        http().get(`${base()}/${uploadId}`).set(as(who));

      const statuses = await Promise.all(
        [alice, bob, orgAdmin, owner].map(async (u) => (await get(u)).status),
      );
      expect(statuses).toEqual([200, 404, 404, 404]);
      expect((await get(alice, randomUUID())).status).toBe(404);
      expect((await get(alice, 'abc')).status).toBe(400);
    });

    it('quá hạn mà chưa complete → báo `expired` ngay, không đợi job dọn dẹp', async () => {
      const { id } = (await init(alice).expect(201)).body.data;
      await db
        .update(uploads)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(uploads.id, id));

      const res = await http().get(`${base()}/${id}`).set(as(alice)).expect(200);
      expect(res.body.data.status).toBe('expired');
    });
  });

  describe('DELETE …/uploads/:uploadId', () => {
    it('huỷ → 204, `aborted`, multipart không còn trên S3; gọi lại → 204', async () => {
      const { id } = (await init(alice).expect(201)).body.data;

      await http().delete(`${base()}/${id}`).set(as(alice)).expect(204);
      await http().delete(`${base()}/${id}`).set(as(alice)).expect(204);

      const row = await rowOf(id);
      expect(row?.status).toBe('aborted');
      expect(row?.storageAbortedAt).toBeInstanceOf(Date);
      expect(await multipartAlive(id)).toBe(false);
    });

    it('người khác huỷ → 404; upload đã complete → 409 UPLOAD_NOT_ACTIVE', async () => {
      const { id } = (await init(alice).expect(201)).body.data;
      await http().delete(`${base()}/${id}`).set(as(bob)).expect(404);

      const meeting = await insertMeeting(db, orgId, alice.id);
      await db
        .update(uploads)
        .set({ status: 'completed', meetingId: meeting.id, completedAt: new Date() })
        .where(eq(uploads.id, id));
      const res = await http().delete(`${base()}/${id}`).set(as(alice)).expect(409);
      expect(res.body.error.code).toBe('UPLOAD_NOT_ACTIVE');
    });
  });
});
