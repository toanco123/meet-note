import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { uploads } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { createTestStorage } from '../../support/storage.js';

const MiB = 1024 * 1024;

describe('Upload init với Idempotency-Key (e2e, RustFS thật)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let alice: TestUser;
  let bob: TestUser;
  let orgId: string;
  let keySeq = 0;
  const s3 = createTestStorage();
  const { bucket } = inject('s3');

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const valid = {
    filename: 'giao-ban.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 20 * MiB,
    sha256: 'd'.repeat(64),
    title: 'Giao ban',
    recordedAt: '2026-10-19T02:00:00.000Z',
  };
  const newKey = () => `init-${++keySeq}-${Date.now()}`;
  const init = (who: TestUser, key?: string, body: object = valid) => {
    const req = http().post(`/v1/orgs/${orgId}/uploads`).set(as(who));
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const uploadsOf = async (who: TestUser) =>
    (await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.userId, who.id))).map(
      (u) => u.id,
    );
  /** Multipart đang mở trên S3 của người dùng — bằng chứng "init chạy thật" không chỉ dựa vào DB. */
  const openMultiparts = async (uploadIds: string[]) => {
    const res = await s3.client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `orgs/${orgId}/uploads/` }),
    );
    return (res.Uploads ?? [])
      .map((u) => u.Key?.split('/')[3])
      .filter((id): id is string => id !== undefined && uploadIds.includes(id));
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    const owner = await registerUser(app);
    [alice, bob] = await Promise.all([registerUser(app), registerUser(app)]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Idem' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, alice.id, 'member');
    await addMember(db, orgId, bob.id, 'member');
  });

  afterAll(async () => {
    s3.close();
    await app.close();
  });

  it('cùng key + cùng body → 201 cả hai, CÙNG upload, lần 2 có `Idempotent-Replayed`; chỉ 1 multipart trên S3', async () => {
    const before = await uploadsOf(alice);
    const key = newKey();

    const first = await init(alice, key).expect(201);
    const again = await init(alice, key).expect(201);

    expect(again.body.data).toEqual(first.body.data);
    expect([first.headers['idempotent-replayed'], again.headers['idempotent-replayed']]).toEqual([
      undefined,
      'true',
    ]);
    // Bản trả lại là request MỚI: requestId của chính nó, không phải của lần đầu.
    expect(again.body.meta.requestId).toBe(again.headers['x-request-id']);
    expect(again.body.meta.requestId).not.toBe(first.body.meta.requestId);
    const created = (await uploadsOf(alice)).filter((id) => !before.includes(id));
    expect(created).toEqual([first.body.data.id]);
    expect(await openMultiparts(created)).toEqual([first.body.data.id]);
  });

  it('không gửi key → mỗi lần init là một upload mới (hành vi cũ, gọi lại KHÔNG an toàn)', async () => {
    const [a, b] = await Promise.all([init(alice).expect(201), init(alice).expect(201)]);
    expect(a.body.data.id).not.toBe(b.body.data.id);
  });

  it('cùng key, body khác → 422 IDEMPOTENCY_KEY_REUSED, không tạo upload', async () => {
    const key = newKey();
    await init(alice, key).expect(201);
    const before = await uploadsOf(alice);

    const res = await init(alice, key, { ...valid, title: 'Họp khác' }).expect(422);

    expect([res.body.error.code, (await uploadsOf(alice)).length]).toEqual([
      'IDEMPOTENCY_KEY_REUSED',
      before.length,
    ]);
  });

  it('key theo từng người dùng: Alice và Bob cùng key → hai upload riêng', async () => {
    const key = newKey();
    const [a, b] = await Promise.all([init(alice, key).expect(201), init(bob, key).expect(201)]);
    expect([a.body.data.id === b.body.data.id, b.headers['idempotent-replayed']]).toEqual([
      false,
      undefined,
    ]);
  });

  it('request lỗi (400) không được ghi nhớ: sửa body rồi gửi lại CÙNG key → 201', async () => {
    const key = newKey();
    const bad = await init(alice, key, { ...valid, sizeBytes: 0 }).expect(400);
    const good = await init(alice, key).expect(201);
    expect([bad.body.error.code, good.headers['idempotent-replayed']]).toEqual([
      'VALIDATION_FAILED',
      undefined,
    ]);
  });

  it('5 init SONG SONG cùng key → đúng 1 upload; các request 201 cùng id, còn lại 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const before = await uploadsOf(alice);
    const key = newKey();

    const results = await Promise.all(Array.from({ length: 5 }, () => init(alice, key)));

    const created = (await uploadsOf(alice)).filter((id) => !before.includes(id));
    expect(created).toHaveLength(1);
    const outcomes = results.map((r) =>
      r.status === 201
        ? `201 ${r.body.data.id === created[0]}`
        : `${r.status} ${r.body.error.code}`,
    );
    expect(outcomes.filter((o) => o !== '201 true' && o !== '409 IDEMPOTENCY_IN_PROGRESS')).toEqual(
      [],
    );
    expect(outcomes).toContain('201 true');
  });

  it('header sai dạng (quá 255 ký tự / có khoảng trắng) → 400, không tạo upload', async () => {
    const before = (await uploadsOf(alice)).length;
    // Ký tự ngoài ASCII thì chính HTTP client của Node đã từ chối gửi → chỉ thử được khoảng trắng.
    const results = await Promise.all([init(alice, 'k'.repeat(256)), init(alice, 'has space')]);
    expect(results.map((r) => [r.status, r.body.error.details?.[0]?.field])).toEqual([
      [400, 'headers.idempotency-key'],
      [400, 'headers.idempotency-key'],
    ]);
    expect((await uploadsOf(alice)).length).toBe(before);
  });
});
