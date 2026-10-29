import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { meetings } from '../../../src/infra/database/schema/index.js';
import { JobName } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { StatsScheduler } from '../../../src/modules/dashboard/stats.scheduler.js';
import { DashboardRepository } from '../../../src/modules/dashboard/repositories/dashboard.repository.js';
import { localDate } from '../../../src/modules/reports/report-week.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { insertMeeting } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

/** Rollup dashboard qua BullMQ THẬT (M17 B2): sự kiện xoá / sửa meeting, tick, job đêm; worker thật. */
describe('Rollup dashboard: job qua queue + worker (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  let repo: DashboardRepository;
  let owner: TestUser;
  let orgId: string;
  const workers: INestApplicationContext[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    repo = new DashboardRepository(db);
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
    owner = await registerUser(app);
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Rollup' }).expect(201)).body
      .data.id as string;
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  const startWorker = async () => {
    const w = await createTestWorker();
    workers.push(w);
    return w;
  };
  const meeting = (recordedAt: string, over: Partial<typeof meetings.$inferInsert> = {}) =>
    insertMeeting(db, orgId, owner.id, {
      recordedAt: new Date(recordedAt),
      status: 'completed',
      durationMs: 60_000,
      ...over,
    });
  const total = async (day: string) => (await repo.readRange(orgId, day, day))[0]?.meetingsTotal;
  const waitTotal = (day: string, expected: number) =>
    vi.waitFor(async () => expect(await total(day)).toBe(expected), {
      timeout: 20_000,
      interval: 100,
    });
  const runJob = async (name: string, data: object) => {
    const job = await queue.add(name, data, { jobId: `test-${crypto.randomUUID()}` });
    await vi.waitFor(async () => expect(['completed', 'failed']).toContain(await job.getState()), {
      timeout: 20_000,
      interval: 100,
    });
    return queue.getJob(job.id!);
  };

  it('xoá meeting (kể cả ngày cũ) → api xếp job → worker tính lại → số ngày đó GIẢM ngay, không đợi tick', async () => {
    const day = '2026-02-10'; // ngày cũ: không nằm trong "hôm nay / hôm qua"
    const a = await meeting('2026-02-10T03:00:00Z');
    await meeting('2026-02-10T05:00:00Z');
    await repo.rollupDay(orgId, day);
    expect(await total(day)).toBe(2);

    await startWorker();
    await http().delete(`/v1/orgs/${orgId}/meetings/${a.id}`).set(as(owner)).expect(204);
    await waitTotal(day, 1);
  });

  it('sửa recorded_at sang ngày khác → CẢ HAI ngày được tính lại (ngày cũ giảm, ngày mới tăng)', async () => {
    const oldDay = '2026-03-03';
    const newDay = '2026-03-05';
    const m = await meeting('2026-03-03T03:00:00Z');
    await repo.rollupDay(orgId, oldDay);
    await repo.rollupDay(orgId, newDay);
    expect([await total(oldDay), await total(newDay)]).toEqual([1, 0]);

    await startWorker();
    await http()
      .patch(`/v1/orgs/${orgId}/meetings/${m.id}`)
      .set(as(owner))
      .send({ recordedAt: '2026-03-05T03:00:00Z' })
      .expect(200);
    await waitTotal(oldDay, 0); // đột biến: chỉ tính lại ngày mới → ngày cũ giữ số 1 mãi
    await waitTotal(newDay, 1);
  });

  it('sửa recorded_at trong CÙNG ngày hoặc chỉ sửa tiêu đề → không xếp job rollup', async () => {
    const m = await meeting('2026-04-06T03:00:00Z');
    const jobsNamed = async () =>
      (await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).filter(
        (j) =>
          j.name === JobName.StatsRollup && j.data.orgId === orgId && j.data.day === '2026-04-06',
      ).length;
    expect(await jobsNamed()).toBe(0);
    await http()
      .patch(`/v1/orgs/${orgId}/meetings/${m.id}`)
      .set(as(owner))
      .send({ title: 'Đổi tên thôi' })
      .expect(200);
    await http()
      .patch(`/v1/orgs/${orgId}/meetings/${m.id}`)
      .set(as(owner))
      .send({ recordedAt: '2026-04-06T08:00:00Z' }) // cùng ngày VN
      .expect(200);
    expect(await jobsNamed()).toBe(0);
  });

  // Đột biến: bỏ `.catch` quanh enqueue → Redis lỗi làm xoá meeting trả 500 dù DB đã commit.
  it('Redis lỗi lúc xếp job: xoá / sửa meeting VẪN thành công (job đêm sẽ tính lại), không 500', async () => {
    const spy = vi
      .spyOn(app.get(StatsScheduler), 'enqueueDayChanged')
      .mockRejectedValue(new Error('redis down'));
    try {
      const a = await meeting('2026-08-04T03:00:00Z');
      const b = await meeting('2026-08-05T03:00:00Z');
      await http().delete(`/v1/orgs/${orgId}/meetings/${a.id}`).set(as(owner)).expect(204);
      await http()
        .patch(`/v1/orgs/${orgId}/meetings/${b.id}`)
        .set(as(owner))
        .send({ recordedAt: '2026-08-07T03:00:00Z' })
        .expect(200);
      expect(spy).toHaveBeenCalledTimes(3); // 1 (xoá) + 2 ngày (sửa)
    } finally {
      spy.mockRestore();
    }
  });

  it('tick: meeting vừa đổi (không có sự kiện) được tính lại theo NGÀY CỦA NÓ', async () => {
    const day = '2026-01-12';
    await meeting('2026-01-12T03:00:00Z');
    await meeting('2026-01-12T04:00:00Z', { status: 'failed', failureCode: 'TRANSCRIBE_FAILED' });
    expect(await total(day)).toBeUndefined(); // chưa ai tính

    await startWorker();
    const job = await runJob(JobName.StatsTick, {});
    expect(await job!.getState()).toBe('completed');
    await waitTotal(day, 2);
    const [row] = await repo.readRange(orgId, day, day);
    expect(row).toMatchObject({ meetingsCompleted: 1, meetingsFailed: 1 });
  });

  it('job đêm: tính lại 92 ngày gần nhất của MỌI tổ chức (meeting 20 và 60 ngày trước được lấp, 120 ngày trước thì không)', async () => {
    const today = localDate(new Date());
    const twentyAgo = new Date(Date.now() - 20 * 86_400_000);
    const day = localDate(twentyAgo);
    const sixtyAgo = localDate(new Date(Date.now() - 60 * 86_400_000));
    const farAgo = localDate(new Date(Date.now() - 120 * 86_400_000));
    await meeting(twentyAgo.toISOString());
    await meeting(new Date(Date.now() - 60 * 86_400_000).toISOString());
    await meeting(new Date(Date.now() - 120 * 86_400_000).toISOString()); // ngoài 92 ngày
    expect(await total(day)).toBeUndefined();

    await startWorker();
    const job = await runJob(JobName.StatsReconcile, {});
    expect(await job!.getState()).toBe('completed');
    await waitTotal(day, 1);
    await waitTotal(sixtyAgo, 1);
    expect(await total(farAgo)).toBeUndefined(); // ngoài khoảng: không đụng
    expect(await total(today)).toBeDefined(); // hôm nay được tính (dòng 0 cũng là dòng)
  });
});
