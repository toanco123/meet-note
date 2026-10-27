import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  channels,
  meetingSummaries,
  notifications,
  weeklyReports,
  weeklyReportVersions,
} from '../../../src/infra/database/schema/index.js';
import { FakeReportWriter } from '../../../src/infra/llm/fake.report-writer.js';
import { LlmTransientError } from '../../../src/infra/llm/llm.errors.js';
import { JobName, reportJobId } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { ReportScheduler } from '../../../src/modules/reports/report.scheduler.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../support/db-factories.js';

const WEEK = '2026-10-05';

/** Tick + generate qua BullMQ THẬT (M9 B5): Redis, Postgres, worker thật; LLM giả. */
describe('Báo cáo tuần: tick → generate (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  const workers: INestApplicationContext[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
  });

  // Mọi worker trong file chung queue → đóng sau MỖI test (bài học M6 B5).
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  const startWorker = async (over: Parameters<typeof createTestWorker>[0] = {}) => {
    const worker = await createTestWorker({ reportWriter: new FakeReportWriter(), ...over });
    workers.push(worker);
    return worker;
  };

  /** Một org với các kênh đủ loại (mỗi kênh `n` meeting completed trong WEEK). */
  async function world() {
    const owner = await insertUser(db);
    const org = await insertOrg(db, owner.id);
    const make = async (name: string, meetingCount: number) => {
      const channel = await insertChannel(db, org.id, owner.id, { name });
      for (let i = 0; i < meetingCount; i++) {
        const m = await insertMeeting(db, org.id, owner.id, {
          title: `${name} ${i}`,
          recordedAt: new Date(Date.UTC(2026, 9, 6, i + 1)),
          status: 'completed',
        });
        await shareMeeting(db, org.id, m.id, channel.id);
        await db.insert(meetingSummaries).values({
          meetingId: m.id,
          orgId: org.id,
          content: {
            overview: `Tóm tắt ${name} ${i}`,
            keyPoints: [],
            decisions: [],
            actionItems: [],
          },
          model: 'fake',
          promptVersion: 'v1',
          inputTokens: 1,
          outputTokens: 1,
        });
      }
      return channel.id;
    };
    const ch = {
      du: await make(`du-${org.id.slice(-4)}`, 2), // đủ 2 meeting → completed
      thieu: await make(`thieu-${org.id.slice(-4)}`, 1), // 1 meeting → skipped
      trong: await make(`trong-${org.id.slice(-4)}`, 0), // 0 meeting → skipped
      tat: await make(`tat-${org.id.slice(-4)}`, 3),
      luuTru: await make(`luutru-${org.id.slice(-4)}`, 3),
      daXoa: await make(`daxoa-${org.id.slice(-4)}`, 3),
    };
    await db.update(channels).set({ weeklyReportEnabled: false }).where(eq(channels.id, ch.tat));
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch.luuTru));
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, ch.daXoa));
    return {
      owner,
      org,
      ch,
      channelIds: Object.values(ch),
      names: { du: `du-${org.id.slice(-4)}` },
    };
  }
  const reportsOf = (channelIds: string[]) =>
    db.select().from(weeklyReports).where(inArray(weeklyReports.channelId, channelIds));
  const tick = async (weekStart = WEEK) => {
    const job = await queue.add(
      JobName.WeeklyReportTick,
      { weekStart },
      { jobId: `tick-${crypto.randomUUID()}` },
    );
    await vi.waitFor(async () => expect(['completed', 'failed']).toContain(await job.getState()), {
      timeout: 20_000,
      interval: 100,
    });
    return queue.getJob(job.id!);
  };
  const waitFinal = (channelIds: string[], count: number) =>
    vi.waitFor(
      async () => {
        const rows = await reportsOf(channelIds);
        expect(rows).toHaveLength(count);
        expect(rows.every((r) => ['completed', 'skipped', 'failed'].includes(r.status))).toBe(true);
      },
      { timeout: 20_000, interval: 100 },
    );

  it('tick: chỉ kênh bật / chưa lưu trữ / chưa xoá có báo cáo; đủ meeting → completed, thiếu → skipped', async () => {
    const w = await world();
    await startWorker();
    const job = await tick();
    await waitFinal(w.channelIds, 3);
    const byChannel = new Map((await reportsOf(w.channelIds)).map((r) => [r.channelId, r]));

    expect(job?.returnvalue).toMatchObject({ weekStart: WEEK });
    expect([...byChannel.keys()].sort()).toEqual([w.ch.du, w.ch.thieu, w.ch.trong].sort());
    expect([
      byChannel.get(w.ch.du)?.status,
      byChannel.get(w.ch.thieu)?.status,
      byChannel.get(w.ch.trong)?.status,
    ]).toEqual(['completed', 'skipped', 'skipped']);
    const versions = await db
      .select()
      .from(weeklyReportVersions)
      .where(eq(weeklyReportVersions.reportId, byChannel.get(w.ch.du)!.id));
    expect(versions.map((v) => [v.version, v.trigger, v.meetingIds.length])).toEqual([
      [1, 'scheduled', 2],
    ]);
  });

  // Đột biến: bỏ `ON CONFLICT DO NOTHING` → tick thứ hai lỗi 23505; bỏ jobId cố định → job trùng.
  it('IDEMPOTENT: tick chạy lại + hai worker cùng tick → mỗi kênh đúng 1 báo cáo, 1 job, 1 phiên bản', async () => {
    const w = await world();
    const writer = new FakeReportWriter();
    await Promise.all([
      startWorker({ reportWriter: writer }),
      startWorker({ reportWriter: writer }),
    ]);
    await Promise.all([tick(), tick(), tick()]);
    await waitFinal(w.channelIds, 3);
    await vi.waitFor(async () => expect(writer.calls).toBeGreaterThanOrEqual(1), {
      timeout: 5_000,
    });

    const rows = await reportsOf(w.channelIds);
    const versionCount = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from weekly_report_versions
      where report_id = any(${sql.param(rows.map((r) => r.id))}::uuid[])`);
    expect(rows).toHaveLength(3);
    expect(versionCount.rows[0]?.n).toBe(1); // chỉ kênh `du` có phiên bản
    expect(writer.calls).toBe(1); // LLM chỉ được gọi MỘT lần dù tick ba lần
    const jobIds = (await queue.getJobs(['completed', 'waiting', 'active', 'delayed', 'failed']))
      .map((j) => j.id)
      .filter(
        (id) =>
          id?.startsWith(`${JobName.WeeklyReportGenerate}.`) && rows.some((r) => id.includes(r.id)),
      );
    expect(new Set(jobIds).size).toBe(jobIds.length); // không job nào bị nhân đôi
  });

  // Đột biến: pha 2 chỉ xếp job cho dòng VỪA chèn → dòng `pending` mồ côi của tick chết không bao giờ chạy.
  it('tick trước chết giữa hai pha (đã chèn dòng `pending`, chưa xếp job) → chạy lại vẫn xếp đủ', async () => {
    const w = await world();
    await db.insert(weeklyReports).values([
      { channelId: w.ch.du, orgId: w.org.id, weekStart: WEEK },
      { channelId: w.ch.thieu, orgId: w.org.id, weekStart: WEEK },
      { channelId: w.ch.trong, orgId: w.org.id, weekStart: WEEK },
    ]);
    await startWorker();
    const job = await tick();
    await waitFinal(w.channelIds, 3);
    // Cả 3 dòng đã có từ tick chết → tick này không tạo gì mới, vẫn phải xếp đủ 3 job.
    expect(job?.returnvalue).toMatchObject({ created: 0, enqueued: 3 });
  });

  it('một báo cáo enqueue lỗi KHÔNG chặn kênh khác; tick báo lỗi để chạy lại, chạy lại chỉ làm phần thiếu', async () => {
    const w = await world();
    const worker = await startWorker();
    const scheduler = worker.get(ReportScheduler);
    const original = scheduler.enqueueGenerate.bind(scheduler);
    let poisoned: string | undefined;
    vi.spyOn(scheduler, 'enqueueGenerate').mockImplementation(async (job) => {
      poisoned ??= job.reportId;
      if (job.reportId === poisoned) throw new Error('Redis lỗi giả');
      return original(job);
    });
    const first = await tick();
    await vi.waitFor(
      async () => {
        const rows = await reportsOf(w.channelIds);
        expect(rows.filter((r) => r.status !== 'pending')).toHaveLength(2); // 2 kênh còn lại vẫn chạy
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(await first?.getState()).toBe('failed');
    expect(first?.failedReason).toContain('chưa xếp được job');

    vi.restoreAllMocks();
    const second = await tick();
    await waitFinal(w.channelIds, 3);
    expect(second?.returnvalue).toMatchObject({ created: 0, enqueued: 1 }); // chỉ báo cáo còn thiếu
  });

  it('weekStart không phải Thứ Hai (backfill sai) → job fail ngay, không tạo dòng nào', async () => {
    const w = await world();
    await startWorker();
    const job = await tick('2026-10-06'); // Thứ Ba
    expect([await job?.getState(), job?.failedReason]).toEqual([
      'failed',
      expect.stringContaining('weekStart không hợp lệ'),
    ]);
    expect(await reportsOf(w.channelIds)).toHaveLength(0);
  });

  it('lỗi TẠM của LLM → job về `delayed` (backoff), promote → hoàn tất; không kẹt `generating`', async () => {
    const w = await world();
    // Lỗi tạm CHỈ ở lần gọi đầu cho kênh của test này: queue dùng chung nên worker có thể nhận job còn
    // sót của test khác — `failTimes` toàn cục sẽ bị chúng "ăn" mất.
    const inner = new FakeReportWriter();
    let failed = false;
    await startWorker({
      reportWriter: {
        write: (input) => {
          if (input.channelName === w.names.du && !failed) {
            failed = true;
            return Promise.reject(new LlmTransientError('lỗi tạm giả'));
          }
          return inner.write(input);
        },
      },
    });
    await tick();
    const reportId = (await reportsOf([w.ch.du]))[0]!.id;
    const id = reportJobId(reportId, 0);
    await vi.waitFor(
      async () => expect(await (await queue.getJob(id))?.getState()).toBe('delayed'),
      {
        timeout: 20_000,
        interval: 100,
      },
    );
    const mid = (await reportsOf([w.ch.du]))[0]!;
    expect([mid.status, mid.generationToken]).toEqual(['generating', null]); // lease đã nhả
    await (await queue.getJob(id))!.promote();
    await waitFinal(w.channelIds, 3);
    expect((await reportsOf([w.ch.du]))[0]?.status).toBe('completed');
  });

  it('lỗi VĨNH VIỄN → failed ngay (không retry) với last_error; HẾT lượt retry → failed', async () => {
    const w = await world();
    await startWorker({ reportWriter: new FakeReportWriter({ permanentFailure: true }) });
    await tick();
    await waitFinal(w.channelIds, 3);
    const permanent = (await reportsOf([w.ch.du]))[0]!;
    const job = await queue.getJob(reportJobId(permanent.id, 0));
    expect([
      permanent.status,
      permanent.lastError,
      job?.attemptsMade,
      await job?.getState(),
    ]).toEqual([
      'failed',
      'Không tạo được báo cáo.',
      1, // không retry
      'failed', // và không nằm ở `delayed` chờ retry
    ]);

    // Hết lượt: job một lần thử, LLM lỗi tạm → đã hết lượt → onFailed đánh failed.
    const w2 = await world();
    const [row] = await db
      .insert(weeklyReports)
      .values({ channelId: w2.ch.du, orgId: w2.org.id, weekStart: WEEK })
      .returning();
    await workers.splice(0)[0]!.close();
    await startWorker({ reportWriter: new FakeReportWriter({ failTimes: 9 }) });
    await queue.add(
      JobName.WeeklyReportGenerate,
      { reportId: row!.id, generation: 0, requestId: null },
      { jobId: `exhaust-${row!.id}`, attempts: 1 },
    );
    await vi.waitFor(async () => expect((await reportsOf([w2.ch.du]))[0]?.status).toBe('failed'), {
      timeout: 20_000,
      interval: 100,
    });
    expect((await reportsOf([w2.ch.du]))[0]?.lastError).toBe(
      'Không tạo được báo cáo. Hãy thử tạo lại.',
    );
  });

  // Đột biến: fan-out gửi cả Khách / cả người ngoài kênh; quên xếp fan-out → không ai nhận.
  it('báo cáo theo lịch xong → thành viên kênh TRỪ Khách nhận `report.ready` (đúng 1 lần dù tick 2 lần)', async () => {
    const w = await world();
    const member = await insertUser(db);
    const admin = await insertUser(db);
    const guest = await insertUser(db);
    const bystander = await insertUser(db); // thành viên org nhưng KHÔNG ở kênh
    for (const u of [member, admin, guest, bystander]) await addMember(db, w.org.id, u.id);
    const du = { id: w.ch.du };
    await addChannelMember(db, du, w.org.id, member.id, 'member');
    await addChannelMember(db, du, w.org.id, admin.id, 'admin');
    await addChannelMember(db, du, w.org.id, guest.id, 'guest');
    await startWorker();
    await tick();
    await tick();
    const expected = [w.owner.id, member.id, admin.id].sort();
    await vi.waitFor(
      async () => {
        const got = await db
          .select()
          .from(notifications)
          .where(eq(notifications.type, 'report.ready'));
        expect(
          got
            .filter((n) => n.orgId === w.org.id)
            .map((n) => n.userId)
            .sort(),
        ).toEqual(expected);
      },
      { timeout: 20_000, interval: 100 },
    );
    const rows = (
      await db.select().from(notifications).where(eq(notifications.orgId, w.org.id))
    ).filter((n) => n.type === 'report.ready');
    expect(rows).toHaveLength(3);
    expect(rows.some((n) => n.userId === guest.id || n.userId === bystander.id)).toBe(false);
    expect(rows[0]?.payload).toMatchObject({ channelId: w.ch.du, weekStart: WEEK, version: 1 });
  });

  it('lịch: cron 08:00 Thứ Hai (giờ VN) — job hẹn giờ bắn đúng mốc, tuần suy từ mốc đó', async () => {
    await startWorker({ schedules: true });
    const scheduler = (await queue.getJobSchedulers()).find((s) => s.key === 'weekly-report-tick');
    const delayed = (await queue.getDelayed()).find((j) => j.name === JobName.WeeklyReportTick);
    expect(scheduler).toMatchObject({ pattern: '0 8 * * 1', tz: 'Asia/Ho_Chi_Minh' });
    const fireAt = new Date(delayed!.timestamp + delayed!.delay);
    // 08:00 giờ VN (UTC+7) = 01:00 UTC, vào Thứ Hai.
    expect([fireAt.getUTCDay(), fireAt.getUTCHours(), fireAt.getUTCMinutes()]).toEqual([1, 1, 0]);
    expect(Math.abs(fireAt.getTime() - (scheduler!.next ?? 0))).toBeLessThan(1_000);
  });
});
