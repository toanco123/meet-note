import { type IncomingHttpHeaders, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { uploadParts, uploads } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

const MiB = 1024 * 1024;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: { error?: { code: string } };
}

describe('Upload: gửi từng phần (e2e, stream)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let port: number;
  let alice: TestUser;
  let bob: TestUser;
  let orgId: string;

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const partPath = (id: string, n: number | string) => `/v1/orgs/${orgId}/uploads/${id}/parts/${n}`;

  async function initUpload(sizeBytes: number): Promise<string> {
    const res = await http()
      .post(`/v1/orgs/${orgId}/uploads`)
      .set(as(alice))
      .send({
        filename: 'a.m4a',
        mimeType: 'audio/mp4',
        sizeBytes,
        sha256: 'a'.repeat(64),
        title: 'Họp',
        recordedAt: '2026-10-19T02:00:00.000Z',
      })
      .expect(201);
    return res.body.data.id as string;
  }

  const putPart = (
    id: string,
    n: number | string,
    size: number,
    who = alice,
    type = 'application/octet-stream',
  ) =>
    http().put(partPath(id, n)).set(as(who)).set('Content-Type', type).send(Buffer.alloc(size, 1));

  const partsInDb = async (id: string) =>
    (
      await db
        .select({ n: uploadParts.partNumber, size: uploadParts.sizeBytes })
        .from(uploadParts)
        .where(eq(uploadParts.uploadId, id))
        .orderBy(uploadParts.partNumber)
    ).map((p) => `${p.n}:${p.size}`);

  /**
   * Request thô (supertest không làm được): tự quyết header, gửi từng mảnh, có thể KHÔNG kết thúc
   * body. Trả về ngay khi server gửi response (kể cả khi body của mình còn đang dở).
   */
  function rawPut(path: string, headers: Record<string, string>, chunks: Buffer[], end: boolean) {
    const req = httpRequest({ port, method: 'PUT', path, headers: { ...as(alice), ...headers } });
    const response = new Promise<RawResponse>((resolve, reject) => {
      req.on('response', (res) => {
        let raw = '';
        res.on('data', (d: Buffer) => (raw += d.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(raw || '{}'),
          }),
        );
      });
      req.on('error', reject);
    });
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
    return { req, response };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = ((app.getHttpServer() as unknown as Server).address() as AddressInfo).port;
    db = app.get(DRIZZLE);
    const owner = await registerUser(app);
    [alice, bob] = await Promise.all([registerUser(app), registerUser(app)]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Parts' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, alice.id, 'member');
    await addMember(db, orgId, bob.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  it('20 MiB = 8 + 8 + 4: gửi phần 1 và phần cuối → 200; trạng thái liệt kê đúng phần đã nhận', async () => {
    const id = await initUpload(20 * MiB);

    const p1 = await putPart(id, 1, 8 * MiB).expect(200);
    const p3 = await putPart(id, 3, 4 * MiB).expect(200);

    expect([p1.body.data, p3.body.data]).toEqual([
      { partNumber: 1, sizeBytes: 8 * MiB },
      { partNumber: 3, sizeBytes: 4 * MiB },
    ]);
    const status = await http().get(`/v1/orgs/${orgId}/uploads/${id}`).set(as(alice)).expect(200);
    expect(status.body.data.receivedParts.map((p: { partNumber: number }) => p.partNumber)).toEqual(
      [1, 3],
    );
  });

  it('gửi lại cùng một phần → 200, vẫn đúng 1 dòng (idempotent)', async () => {
    const id = await initUpload(20 * MiB);
    await putPart(id, 2, 8 * MiB).expect(200);
    await putPart(id, 2, 8 * MiB).expect(200);
    expect(await partsInDb(id)).toEqual([`2:${8 * MiB}`]);
  });

  it('4 phần song song → tất cả 200', async () => {
    const id = await initUpload(32 * MiB);
    const results = await Promise.all([1, 2, 3, 4].map((n) => putPart(id, n, 8 * MiB)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await partsInDb(id)).toHaveLength(4);
  });

  it.each([
    [
      'phần giữa nhỏ hơn chunkSize',
      1,
      MiB,
      'application/octet-stream',
      400,
      'UPLOAD_PART_SIZE_MISMATCH',
    ],
    [
      'phần cuối lớn hơn phần còn lại',
      3,
      4 * MiB + 1,
      'application/octet-stream',
      413,
      'PAYLOAD_TOO_LARGE',
    ],
    ['Content-Type không phải octet-stream', 1, 16, 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['partNumber 0', 0, 16, 'application/octet-stream', 400, 'UPLOAD_PART_OUT_OF_RANGE'],
    [
      'partNumber vượt totalParts',
      4,
      16,
      'application/octet-stream',
      400,
      'UPLOAD_PART_OUT_OF_RANGE',
    ],
    ['partNumber không phải số', 'abc', 16, 'application/octet-stream', 400, 'VALIDATION_FAILED'],
  ] as const)('%s → %i', async (_label, n, size, type, status, code) => {
    const id = await initUpload(20 * MiB);
    const res = await putPart(id, n, size, alice, type);
    expect([res.status, res.body.error?.code]).toEqual([status, code]);
    expect(await partsInDb(id)).toEqual([]);
  });

  it('người khác → 404; hết hạn → 410; đã huỷ → 409', async () => {
    const other = await initUpload(20 * MiB);
    const expired = await initUpload(20 * MiB);
    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, expired));
    const cancelled = await initUpload(20 * MiB);
    await http().delete(`/v1/orgs/${orgId}/uploads/${cancelled}`).set(as(alice)).expect(204);

    const results = await Promise.all([
      putPart(other, 1, 8 * MiB, bob),
      putPart(expired, 1, 8 * MiB),
      putPart(cancelled, 1, 8 * MiB),
    ]);
    expect(results.map((r) => [r.status, r.body.error?.code])).toEqual([
      [404, 'NOT_FOUND'],
      [410, 'UPLOAD_EXPIRED'],
      [409, 'UPLOAD_NOT_ACTIVE'],
    ]);
  });

  /**
   * Khai `Content-Length` 1 GiB, chỉ gửi 64 KiB rồi NGỪNG: server phải trả 413 ngay từ header (nếu
   * server đợi đọc hết body thì test treo tới timeout), và đặt `Connection: close` để Node không
   * đọc-rồi-bỏ 1 GiB còn lại.
   */
  it('413 trả NGAY từ header, không đợi body; kèm Connection: close', async () => {
    const id = await initUpload(20 * MiB);
    const { req, response } = rawPut(
      partPath(id, 3),
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(1024 * MiB) },
      [Buffer.alloc(64 * 1024)],
      false,
    );

    const res = await response;
    req.destroy();
    expect([res.status, res.body.error?.code, res.headers.connection]).toEqual([
      413,
      'PAYLOAD_TOO_LARGE',
      'close',
    ]);
  });

  it('không có Content-Length (Transfer-Encoding: chunked) → 411', async () => {
    const id = await initUpload(20 * MiB);
    const { response } = rawPut(
      partPath(id, 1),
      { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' },
      [Buffer.from('abc')],
      true,
    );
    const res = await response;
    expect([res.status, res.body.error?.code]).toEqual([411, 'LENGTH_REQUIRED']);
  });

  it('client ngắt giữa phần → không lưu phần đó; gửi lại đủ → 200', async () => {
    const id = await initUpload(20 * MiB);
    const { req, response } = rawPut(
      partPath(id, 1),
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(8 * MiB) },
      [Buffer.alloc(MiB)],
      false,
    );
    // Phía client: request do chính mình huỷ sẽ reject "socket hang up" — nuốt đi, không để thành
    // unhandled rejection. (Phía SERVER thì không được nuốt kiểu này: xem controller.)
    response.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await partsInDb(id)).toEqual([]);
    await putPart(id, 1, 8 * MiB).expect(200);
    expect(await partsInDb(id)).toEqual([`1:${8 * MiB}`]);
  });

  it('huỷ upload TRONG LÚC một phần đang gửi → phần đó nhận 409, không có dòng nào được lưu', async () => {
    const id = await initUpload(20 * MiB);
    const { req, response } = rawPut(
      partPath(id, 1),
      { 'Content-Type': 'application/octet-stream', 'Content-Length': String(8 * MiB) },
      [Buffer.alloc(MiB)],
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await http().delete(`/v1/orgs/${orgId}/uploads/${id}`).set(as(alice)).expect(204);
    req.end(Buffer.alloc(7 * MiB));

    const res = await response;
    expect([res.status, res.body.error?.code]).toEqual([409, 'UPLOAD_NOT_ACTIVE']);
    expect(await partsInDb(id)).toEqual([]);
    const [row] = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, id)));
    expect(row?.status).toBe('aborted');
  });
});
