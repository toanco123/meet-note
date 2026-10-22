import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { uploads } from '../../../src/infra/database/schema/index.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { createTestApp } from '../../support/app.js';
import { addMember } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { createTestStorage } from '../../support/storage.js';
import { fixtureDb } from '../../support/db.js';

const MiB = 1024 * 1024;

describe('Upload: complete → meeting `queued` (e2e, Redis + RustFS thật)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  let alice: TestUser;
  let bob: TestUser;
  let orgId: string;
  const s3 = createTestStorage();

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const url = (id: string, suffix = '') => `/v1/orgs/${orgId}/uploads/${id}${suffix}`;

  /** Init + gửi các phần (mặc định đủ). 9 MiB = 8 MiB + 1 MiB. */
  async function upload(sizeBytes = 9 * MiB, partsToSend?: number[]) {
    const res = await http()
      .post(`/v1/orgs/${orgId}/uploads`)
      .set(as(alice))
      .send({
        filename: 'giao-ban.m4a',
        mimeType: 'audio/mp4',
        sizeBytes,
        sha256: 'c'.repeat(64),
        title: 'Giao ban tuần 42',
        recordedAt: '2026-10-19T02:00:00.000Z',
      })
      .expect(201);
    const { id, totalParts, chunkSize } = res.body.data as {
      id: string;
      totalParts: number;
      chunkSize: number;
    };
    const parts = partsToSend ?? Array.from({ length: totalParts }, (_, i) => i + 1);
    for (const n of parts) {
      const size = n < totalParts ? chunkSize : sizeBytes - chunkSize * (totalParts - 1);
      await http()
        .put(url(id, `/parts/${n}`))
        .set(as(alice))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(size, 7))
        .expect(200);
    }
    return id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
    const owner = await registerUser(app);
    [alice, bob] = await Promise.all([registerUser(app), registerUser(app)]);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Complete' }).expect(201))
      .body.data.id;
    await addMember(db, orgId, alice.id, 'member');
    await addMember(db, orgId, bob.id, 'member');
  });

  afterAll(async () => {
    s3.close();
    await app.close();
  });

  it('complete → 201 meeting `queued`; upload `completed`; object đúng 9 MiB; job đúng jobId trong Redis', async () => {
    const id = await upload();

    const res = await http().post(url(id, '/complete')).set(as(alice)).expect(201);
    const meeting = res.body.data;

    expect(meeting).toMatchObject({
      status: 'queued',
      title: 'Giao ban tuần 42',
      ownerId: alice.id,
      durationMs: null,
    });
    expect(res.body.meta.statusCode).toBe(201);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    expect([row?.status, row?.meetingId]).toEqual(['completed', meeting.id]);
    expect(await s3.storage.headObject(row?.objectKey ?? '')).toEqual({ sizeBytes: 9 * MiB });

    const job = await queue.getJob(`meeting.preprocess.${meeting.id}.a1`);
    expect([job?.name, job?.data.meetingId, job?.opts.attempts]).toEqual([
      'meeting.preprocess',
      meeting.id,
      3,
    ]);
    expect(job?.data.requestId).toBe(res.headers['x-request-id']);
  });

  it('gọi lại complete → 200 với CÙNG meeting; không có job thứ hai', async () => {
    const id = await upload();
    const first = await http().post(url(id, '/complete')).set(as(alice)).expect(201);
    const again = await http().post(url(id, '/complete')).set(as(alice)).expect(200);

    expect([again.body.data.id, again.body.meta.statusCode]).toEqual([first.body.data.id, 200]);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    expect(jobs.filter((j) => j.data.meetingId === first.body.data.id)).toHaveLength(1);
  });

  it('còn thiếu phần → 409 UPLOAD_INCOMPLETE, `details` liệt kê phần thiếu; chưa tạo meeting', async () => {
    const id = await upload(20 * MiB, [1]);

    const res = await http().post(url(id, '/complete')).set(as(alice)).expect(409);

    expect(res.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'parts.2',
      'parts.3',
    ]);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    expect(row?.status).toBe('initiated');
  });

  it('người khác → 404; đã huỷ → 409; hết hạn → 410', async () => {
    const other = await upload();
    const cancelled = await upload();
    await http().delete(url(cancelled)).set(as(alice)).expect(204);
    const expired = await upload();
    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, expired));

    const results = await Promise.all([
      http().post(url(other, '/complete')).set(as(bob)),
      http().post(url(cancelled, '/complete')).set(as(alice)),
      http().post(url(expired, '/complete')).set(as(alice)),
    ]);
    expect(results.map((r) => [r.status, r.body.error?.code])).toEqual([
      [404, 'NOT_FOUND'],
      [409, 'UPLOAD_NOT_ACTIVE'],
      [410, 'UPLOAD_EXPIRED'],
    ]);
  });

  it('GET /meetings/:id: chủ xem được; người khác / id lạ → 404 (M5: chỉ chủ)', async () => {
    const id = await upload();
    const meetingId = (await http().post(url(id, '/complete')).set(as(alice)).expect(201)).body.data
      .id;
    const get = (who: TestUser, mid: string) =>
      http().get(`/v1/orgs/${orgId}/meetings/${mid}`).set(as(who));

    const statuses = await Promise.all([
      get(alice, meetingId),
      get(bob, meetingId),
      get(alice, randomUUID()),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([200, 404, 404]);
    expect(statuses[0]?.body.data).toMatchObject({ id: meetingId, status: 'queued' });
  });
});
