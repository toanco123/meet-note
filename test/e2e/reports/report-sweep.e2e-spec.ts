import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { meetingSummaries, weeklyReports } from '../../../src/infra/database/schema/index.js';
import { FakeReportWriter } from '../../../src/infra/llm/fake.report-writer.js';
import { reportJobId } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { ReportScheduler } from '../../../src/modules/reports/report.scheduler.js';
import { ReportsRepository } from '../../../src/modules/reports/reports.repository.js';
import { ReportSweepService } from '../../../src/modules/reports/services/report-sweep.service.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../support/db-factories.js';

const WEEK = '2026-10-05';

/** Quét báo cáo kẹt (M9 B7): worker thật, Redis thật; gọi `sweep()` thay vì chờ lịch 5 phút. */
describe('Quét báo cáo kẹt (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  let sweeper: ReportSweepService;
  const workers: INestApplicationContext[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
    // Dựng bằng tay từ thành phần của api: không có worker → không ai tiêu thụ job được xếp lại.
    sweeper = new ReportSweepService(
      new ReportsRepository(db),
      app.get(ReportScheduler, { strict: false }),
    );
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Kênh có 2 meeting đủ điều kiện + một dòng báo cáo (chưa có job nào). */
  async function stuckReport(
    over: Partial<typeof weeklyReports.$inferInsert> = {},
    backdate = true,
  ) {
    const owner = await insertUser(db);
    const org = await insertOrg(db, owner.id);
    const channel = await insertChannel(db, org.id, owner.id, { name: `k-${org.id.slice(-4)}` });
    for (let i = 0; i < 2; i++) {
      const m = await insertMeeting(db, org.id, owner.id, {
        title: `Họp ${i}`,
        recordedAt: new Date(Date.UTC(2026, 9, 6, i + 1)),
        status: 'completed',
      });
      await shareMeeting(db, org.id, m.id, channel.id);
      await db.insert(meetingSummaries).values({
        meetingId: m.id,
        orgId: org.id,
        content: { overview: `Tóm tắt ${i}`, keyPoints: [], decisions: [], actionItems: [] },
        model: 'fake',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    const [report] = await db
      .insert(weeklyReports)
      .values({ channelId: channel.id, orgId: org.id, weekStart: WEEK, ...over })
      .returning();
    // `updated_at` bằng SQL thô: `$onUpdate` của Drizzle sẽ ghi đè thành now().
    if (backdate) {
      await db.execute(
        sql`update weekly_reports set updated_at = now() - interval '1 hour' where id = ${report!.id}`,
      );
    }
    return report!;
  }
  const row = async (id: string) =>
    (await db.select().from(weeklyReports).where(eq(weeklyReports.id, id)))[0]!;
  const jobsOf = async (id: string) =>
    (await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']))
      .map((j) => j.id!)
      .filter((jobId) => jobId.includes(id))
      .sort();
  const waitStatus = (id: string, status: string) =>
    vi.waitFor(async () => expect((await row(id)).status).toBe(status), {
      timeout: 20_000,
      interval: 100,
    });
  /** Chỉ xét báo cáo của test này: queue / DB dùng chung với các test khác trong file. */
  const mine = (result: { requeued: string[]; skipped: string[] }, id: string) => ({
    requeued: result.requeued.includes(id),
    skipped: result.skipped.includes(id),
  });

  // Đột biến: `requeue` dùng lại jobId thường `…g0` → job cũ (completed, còn giữ) nuốt `add()`.
  it('`pending` mất job (enqueue sau commit lỗi) → quét → xếp lại → worker tạo xong', async () => {
    const r = await stuckReport();
    workers.push(await createTestWorker({ reportWriter: new FakeReportWriter() }));
    const result = await workers[0]!.get(ReportSweepService).sweep();
    await waitStatus(r.id, 'completed');
    expect(mine(result, r.id)).toEqual({ requeued: true, skipped: false });
  });

  it('`generating` hết lease (worker chết cứng) → quét → xếp lại → worker khác nhận và xong', async () => {
    const r = await stuckReport({
      status: 'generating',
      generationToken: crypto.randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });
    workers.push(await createTestWorker({ reportWriter: new FakeReportWriter() }));
    const result = await workers[0]!.get(ReportSweepService).sweep();
    await waitStatus(r.id, 'completed');
    expect(mine(result, r.id).requeued).toBe(true);
  });

  // Đột biến: bỏ điều kiện lease → báo cáo đang chạy thật bị xếp job thứ hai.
  it('KHÔNG đụng: đang chạy (lease còn hạn), vừa đổi (< 10 phút), đã xong / bỏ qua / lỗi', async () => {
    const running = await stuckReport({
      status: 'generating',
      generationToken: crypto.randomUUID(),
      leaseUntil: new Date(Date.now() + 600_000),
    });
    const fresh = await stuckReport({}, false); // vừa tạo
    const done = await stuckReport({ status: 'completed', currentVersion: 1 });
    const skipped = await stuckReport({ status: 'skipped' });
    const failed = await stuckReport({ status: 'failed', lastError: 'x' });
    const result = await sweeper.sweep();
    const touched = [running, fresh, done, skipped, failed].filter(
      (r) => result.requeued.includes(r.id) || result.skipped.includes(r.id),
    );
    expect(touched).toEqual([]);
    expect(
      await Promise.all([running, fresh, done, skipped, failed].map((r) => jobsOf(r.id))),
    ).toEqual([[], [], [], [], []]);
  });

  // Đột biến: bỏ `hasLiveJob` → báo cáo đang chờ retry bị xếp job thứ hai.
  it('đang CHỜ RETRY (job thường còn sống, `delayed`) → để yên, không xếp thêm', async () => {
    const r = await stuckReport();
    await queue.add(
      'weekly-report.generate',
      { reportId: r.id, generation: 0, requestId: null },
      { jobId: reportJobId(r.id, 0), delay: 120_000 },
    );
    const result = await sweeper.sweep();
    expect([mine(result, r.id), await jobsOf(r.id)]).toEqual([
      { requeued: false, skipped: true },
      [reportJobId(r.id, 0)],
    ]);
  });

  it('quét LẶP khi chưa ai nhận việc → cùng jobId (`.r<version>`), không nhân đôi job', async () => {
    const r = await stuckReport();
    const [first, second] = [await sweeper.sweep(), await sweeper.sweep()];
    const ids = await jobsOf(r.id);
    expect([mine(first, r.id).requeued, mine(second, r.id).requeued]).toEqual([true, true]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(new RegExp(`^${reportJobId(r.id, 0).replaceAll('.', '\\.')}\\.r\\d+$`));
  });

  // Đột biến: bỏ keyset `after` → lô 1 dòng lặp lại đúng dòng đầu.
  it('nhiều báo cáo kẹt, lô 1 dòng → keyset đi hết, mỗi báo cáo đúng một lần', async () => {
    const reports = [await stuckReport(), await stuckReport(), await stuckReport()];
    const result = await sweeper.sweep({ batchSize: 1 });
    const ours = new Set(reports.map((r) => r.id));
    const requeued = result.requeued.filter((id) => ours.has(id));
    expect([requeued.length, new Set(requeued).size]).toEqual([3, 3]);
  });

  it('job tạo lại thủ công của báo cáo kẹt mang đúng `generation` (fencing)', async () => {
    const r = await stuckReport({ regenerateCount: 2, requestedTrigger: 'manual' });
    await sweeper.sweep();
    const [id] = await jobsOf(r.id);
    expect(id).toMatch(new RegExp(`^${reportJobId(r.id, 2).replaceAll('.', '\\.')}\\.r\\d+$`));
    const job = await queue.getJob(id!);
    expect(job?.data).toEqual({ reportId: r.id, generation: 2, requestId: null });
  });
});
