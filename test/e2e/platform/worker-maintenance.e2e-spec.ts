import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { channels, idempotencyKeys, uploads } from '../../../src/infra/database/schema/index.js';
import { JobName } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { ChannelsPurgeService } from '../../../src/modules/channels/services/channels-purge.service.js';
import { SCHEDULES } from '../../../src/worker/worker-schedules.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { insertChannel, insertOrg, insertUpload, insertUser } from '../../support/db-factories.js';

/** Lịch chạy + việc định kỳ của worker (M6 B8): Job Scheduler trong Redis thật, Postgres thật. */
describe('Worker: lịch chạy + dọn dẹp định kỳ (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  const workers: INestApplicationContext[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  // Đột biến: bỏ bước xoá lịch không còn khai báo → `lich-cu` còn (5 lịch).
  it('2 worker khởi động CÙNG LÚC → mỗi lịch đúng 1 scheduler, 1 job hẹn giờ; lịch cũ không còn khai báo bị xoá', async () => {
    await queue.upsertJobScheduler('lich-cu', { pattern: '0 0 * * *' }, { name: 'old.job' });
    workers.push(
      ...(await Promise.all([
        createTestWorker({ schedules: true }),
        createTestWorker({ schedules: true }),
      ])),
    );
    const schedulers = await queue.getJobSchedulers();
    const delayed = await queue.getDelayed();
    const names = new Set<string>(SCHEDULES.map((s) => s.name));

    expect(
      schedulers
        .map((s) => [s.key, s.pattern, s.tz, s.name])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual(
      SCHEDULES.map((s) => [s.id, s.pattern, 'Asia/Ho_Chi_Minh', s.name]).sort((a, b) =>
        a[0]!.localeCompare(b[0]!),
      ),
    );
    // Upsert theo id: 2 worker cùng đăng ký vẫn đúng MỘT job hẹn giờ cho mốc kế tiếp của mỗi lịch.
    expect(delayed.filter((j) => names.has(j.name))).toHaveLength(SCHEDULES.length);
  });

  async function runJob(name: string): Promise<unknown> {
    const job = await queue.add(name, {});
    await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), {
      timeout: 20_000,
      interval: 100,
    });
    return (await queue.getJob(job.id!))?.returnvalue;
  }

  it('job dọn chạy trong WORKER thấy mọi tổ chức; cùng service gọi từ api (RLS, không ngữ cảnh) thấy 0 dòng', async () => {
    const user = await insertUser(db);
    const orgs = await Promise.all([insertOrg(db, user.id), insertOrg(db, user.id)]);
    const deleted = await Promise.all(orgs.map((o) => insertChannel(db, o.id, user.id)));
    await db
      .update(channels)
      .set({ deletedAt: sql`now() - interval '40 days'` })
      .where(
        inArray(
          channels.id,
          deleted.map((c) => c.id),
        ),
      );
    const expiredUploads = await Promise.all(
      orgs.map((o) =>
        insertUpload(db, o.id, user.id, { expiresAt: new Date(Date.now() - 3_600_000) }),
      ),
    );
    await db.insert(idempotencyKeys).values({
      userId: user.id,
      key: 'het-han',
      method: 'POST',
      path: '/v1/x',
      requestHash: 'h',
      status: 'processing',
      expiresAt: sql`now() - interval '1 minute'`,
    });

    // Api: user `meetnote_api_login` dưới RLS, ngoài request → không có `app.org_id` → 0 dòng, KHÔNG lỗi.
    const fromApi = await app.get(ChannelsPurgeService).purgeBatch();

    workers.push(await createTestWorker());
    const results = {
      purge: await runJob(JobName.ChannelPurge),
      uploads: await runJob(JobName.UploadCleanup),
      idempotency: await runJob(JobName.IdempotencyCleanup),
      sweep: await runJob(JobName.MeetingSweepStuck),
    };
    const channelsLeft = await db
      .select({ id: channels.id })
      .from(channels)
      .where(
        inArray(
          channels.id,
          deleted.map((c) => c.id),
        ),
      );
    const uploadStatus = await Promise.all(
      expiredUploads.map(
        async (u) =>
          (await db.select().from(uploads).where(eq(uploads.id, u.id)))[0]?.status as string,
      ),
    );
    const keys = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, user.id));

    expect(fromApi).toEqual([]);
    expect(results).toEqual({
      purge: { purged: 2 },
      // s3UploadId giả → S3 trả `NoSuchUpload` = coi như đã abort (abort idempotent, M5) → không lỗi.
      uploads: { expired: 2, storageFailed: 0, retried: 0 },
      idempotency: { deleted: 1 },
      sweep: { requeued: 0, skipped: 0 },
    });
    expect([channelsLeft, uploadStatus, keys]).toEqual([[], ['expired', 'expired'], []]);
  });
});
