import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  channels,
  meetingSummaries,
  weeklyReports,
  weeklyReportVersions,
} from '../../../src/infra/database/schema/index.js';
import { FakeReportWriter } from '../../../src/infra/llm/fake.report-writer.js';
import { reportJobId } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { addDays } from '../../../src/modules/reports/report-week.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

const BASE = '2026-01-05'; // một Thứ Hai
const CONTENT = {
  overview: 'Tuần chốt kế hoạch quý ba.',
  highlights: ['Ngân sách'],
  decisions: ['Chốt kế hoạch'],
  actionItems: [{ owner: 'Bình', task: 'Chuẩn bị ngân sách', due: 'thứ sáu' }],
  meetings: [
    {
      id: '00000000-0000-7000-8000-000000000001',
      title: 'Họp 1',
      recordedAt: '2026-01-06T02:00:00.000Z',
    },
  ],
};

/** API báo cáo tuần (M9 B6): quyền theo ma trận 04, bản đang hiển thị, tạo lại có quota. */
describe('Reports API (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  let orgId: string;
  let owner: TestUser;
  let [co, ca, cm, guest, orgAdm, outsider, stranger]: TestUser[] = [];
  let priv: string; // kênh riêng tư: co, ca, cm, guest
  let pub: string; // kênh công khai
  const workers: INestApplicationContext[] = [];
  let weekCounter = 0;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const url = (channelId: string, suffix = '') =>
    `/v1/orgs/${orgId}/channels/${channelId}/reports${suffix}`;
  /** Thứ Hai mới cho mỗi báo cáo: `UNIQUE (channel_id, week_start)`. */
  const nextWeek = () => addDays(BASE, 7 * weekCounter++);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
    owner = await registerUser(app);
    [co, ca, cm, guest, orgAdm, outsider, stranger] = (await Promise.all(
      Array.from({ length: 7 }, () => registerUser(app)),
    )) as TestUser[];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Báo cáo' }).expect(201))
      .body.data.id as string;
    for (const u of [co, ca, cm, guest, outsider]) await addMember(db, orgId, u!.id);
    await addMember(db, orgId, orgAdm!.id, 'admin');
    const p = await insertChannel(db, orgId, co!.id, { visibility: 'private' });
    await addChannelMember(db, p, orgId, ca!.id, 'admin');
    await addChannelMember(db, p, orgId, cm!.id, 'member');
    await addChannelMember(db, p, orgId, guest!.id, 'guest');
    priv = p.id;
    pub = (await insertChannel(db, orgId, co!.id, { visibility: 'public' })).id;
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Dòng báo cáo (+ các phiên bản) dựng thẳng DB. `versions` = số phiên bản đã có (current = cuối). */
  async function report(
    channelId: string,
    over: Partial<typeof weeklyReports.$inferInsert> & { versions?: number } = {},
  ) {
    const { versions = 0, ...rest } = over;
    const weekStart = rest.weekStart ?? nextWeek();
    const [row] = await db
      .insert(weeklyReports)
      .values({
        channelId,
        orgId,
        weekStart,
        status: versions > 0 ? 'completed' : 'pending',
        currentVersion: versions > 0 ? versions : null,
        ...rest,
      })
      .returning();
    for (let v = 1; v <= versions; v++) {
      await db.insert(weeklyReportVersions).values({
        reportId: row!.id,
        orgId,
        version: v,
        trigger: v === 1 ? 'scheduled' : 'manual',
        triggeredBy: v === 1 ? null : ca!.id,
        content: { ...CONTENT, overview: `Bản ${v}` },
        meetingIds: [],
        model: 'fake',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    return row!;
  }

  describe('đọc', () => {
    it('ma trận xem (kênh riêng tư): CO CA CM G → 200; OrgAdm ngoài kênh → 403; thành viên org ngoài kênh / người ngoài org → 404', async () => {
      const r = await report(priv, { versions: 1 });
      const status = async (u: TestUser, suffix = `/${r.weekStart}`) =>
        (await http().get(url(priv, suffix)).set(as(u))).status;
      expect(
        await Promise.all([co, ca, cm, guest, orgAdm, outsider, stranger].map((u) => status(u!))),
      ).toEqual([200, 200, 200, 200, 403, 404, 404]);
      // Cùng ma trận cho danh sách và danh sách phiên bản.
      expect(await status(cm!, '')).toBe(200);
      expect(await status(orgAdm!, '')).toBe(403);
      expect(await status(cm!, `/${r.weekStart}/versions`)).toBe(200);
      expect(await status(outsider!, `/${r.weekStart}/versions`)).toBe(404);
    });

    it('kênh công khai: thành viên org chưa join cũng xem được', async () => {
      const r = await report(pub, { versions: 1 });
      const res = await http()
        .get(url(pub, `/${r.weekStart}`))
        .set(as(outsider!));
      expect(res.status).toBe(200);
    });

    it('chi tiết: trạng thái + bản đang hiển thị + số lần tạo lại còn lại; chưa đăng nhập → 401', async () => {
      const r = await report(priv, { versions: 2, regenerateCount: 1 });
      const res = await http()
        .get(url(priv, `/${r.weekStart}`))
        .set(as(cm!))
        .expect(200);
      expect(res.body.data).toMatchObject({
        weekStart: r.weekStart,
        status: 'completed',
        currentVersion: 2,
        regenerateCount: 1,
        regenerationsLeft: 2,
        lastError: null,
        version: {
          version: 2,
          trigger: 'manual',
          triggeredBy: ca!.id,
          model: 'fake',
          content: { overview: 'Bản 2' },
        },
      });
      expect(res.body.data.version.content.meetings).toHaveLength(1);
      await http()
        .get(url(priv, `/${r.weekStart}`))
        .expect(401);
    });

    it('tạo lại LỖI không làm mất bản cũ: failed + last_error nhưng vẫn trả bản v1', async () => {
      const r = await report(priv, {
        versions: 1,
        status: 'failed',
        lastError: 'Không tạo được báo cáo.',
        regenerateCount: 1,
      });
      const res = await http()
        .get(url(priv, `/${r.weekStart}`))
        .set(as(cm!))
        .expect(200);
      expect(res.body.data).toMatchObject({
        status: 'failed',
        lastError: 'Không tạo được báo cáo.',
        currentVersion: 1,
        version: { version: 1, content: { overview: 'Bản 1' } },
      });
    });

    it('chưa có phiên bản (đang chờ / bỏ qua) → version null', async () => {
      const r = await report(priv, { status: 'skipped' });
      const res = await http()
        .get(url(priv, `/${r.weekStart}`))
        .set(as(cm!))
        .expect(200);
      expect([res.body.data.status, res.body.data.currentVersion, res.body.data.version]).toEqual([
        'skipped',
        null,
        null,
      ]);
    });

    it('phiên bản: mới nhất trước, đủ nội dung', async () => {
      const r = await report(priv, { versions: 3, regenerateCount: 2 });
      const res = await http()
        .get(url(priv, `/${r.weekStart}/versions`))
        .set(as(cm!))
        .expect(200);
      expect(
        res.body.data.map((v: { version: number; trigger: string }) => [v.version, v.trigger]),
      ).toEqual([
        [3, 'manual'],
        [2, 'manual'],
        [1, 'scheduled'],
      ]);
      expect(res.body.data[0].content.overview).toBe('Bản 3');
    });

    it('danh sách: tuần mới nhất trước, phân trang cursor duyệt hết không lặp; cursor rác → 400', async () => {
      const ch = (await insertChannel(db, orgId, co!.id, { visibility: 'public' })).id;
      const weeks = [
        await report(ch, { weekStart: '2026-03-02' }),
        await report(ch, { weekStart: '2026-03-09' }),
        await report(ch, { weekStart: '2026-03-16' }),
      ];
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: request.Response = await http()
          .get(url(ch))
          .query(cursor ? { limit: 1, cursor } : { limit: 1 })
          .set(as(cm!))
          .expect(200);
        seen.push(...res.body.data.map((r: { weekStart: string }) => r.weekStart));
        cursor = res.body.meta.nextCursor;
      } while (cursor);
      expect(seen).toEqual(weeks.map((w) => w.weekStart).reverse());
      expect((await http().get(url(ch)).query({ cursor: 'rác' }).set(as(cm!))).status).toBe(400);
      const empty = await http().get(url(pub)).set(as(cm!));
      expect(empty.status).toBe(200);
    });

    it('weekStart sai (Thứ Ba, ngày không có thật, rác) → 400; Thứ Hai chưa có báo cáo → 404 REPORT_NOT_FOUND', async () => {
      const get = async (week: string) =>
        await http()
          .get(url(priv, `/${week}`))
          .set(as(cm!));
      const [tuesday, fake, junk, missing] = [
        await get('2026-10-06'),
        await get('2026-02-30'),
        await get('hom-nay'),
        await get('2030-01-07'),
      ];
      expect([
        tuesday.status,
        fake.status,
        junk.status,
        missing.status,
        missing.body.error.code,
      ]).toEqual([400, 400, 400, 404, 'REPORT_NOT_FOUND']);
      expect((await http().post(url(priv, '/2026-10-06/regenerate')).set(as(ca!))).status).toBe(
        400,
      );
    });
  });

  describe('tạo lại', () => {
    it('ma trận: CO CA → 202; CM G OrgAdm → 403; thành viên org ngoài kênh / người ngoài org → 404', async () => {
      const actors = [co, ca, cm, guest, orgAdm, outsider, stranger] as TestUser[];
      const statuses: number[] = [];
      for (const u of actors) {
        const r = await report(priv, { versions: 1 });
        statuses.push(
          (
            await http()
              .post(url(priv, `/${r.weekStart}/regenerate`))
              .set(as(u))
          ).status,
        );
      }
      expect(statuses).toEqual([202, 202, 403, 403, 403, 404, 404]);
    });

    it('202: về pending, quota +1, bản cũ VẪN hiển thị; DB ghi ai bấm; đúng MỘT job `…g1` trong Redis', async () => {
      const r = await report(priv, { versions: 1 });
      const res = await http()
        .post(url(priv, `/${r.weekStart}/regenerate`))
        .set(as(ca!))
        .expect(202);
      expect(res.body.data).toMatchObject({
        status: 'pending',
        regenerateCount: 1,
        regenerationsLeft: 2,
        currentVersion: 1,
        version: { version: 1, content: { overview: 'Bản 1' } },
      });
      const row = (await db.select().from(weeklyReports).where(eq(weeklyReports.id, r.id)))[0]!;
      expect([row.requestedTrigger, row.requestedBy, row.generationToken]).toEqual([
        'manual',
        ca!.id,
        null,
      ]);
      const job = await queue.getJob(reportJobId(r.id, 1));
      expect(job?.data).toMatchObject({
        reportId: r.id,
        generation: 1,
        requestId: expect.any(String),
      });
    });

    it('đang chờ / đang tạo → 409 REPORT_IN_PROGRESS (không tăng quota)', async () => {
      const pending = await report(priv, { versions: 1, status: 'pending' });
      const generating = await report(priv, { versions: 1, status: 'generating' });
      const [a, b] = [
        await http()
          .post(url(priv, `/${pending.weekStart}/regenerate`))
          .set(as(ca!)),
        await http()
          .post(url(priv, `/${generating.weekStart}/regenerate`))
          .set(as(ca!)),
      ];
      const count = (
        await db.select().from(weeklyReports).where(eq(weeklyReports.id, pending.id))
      )[0]!.regenerateCount;
      expect([a.status, a.body.error.code, b.status, b.body.error.code, count]).toEqual([
        409,
        'REPORT_IN_PROGRESS',
        409,
        'REPORT_IN_PROGRESS',
        0,
      ]);
    });

    it('hết 3 lần → 409 REPORT_REGENERATE_LIMIT; báo cáo skipped / failed vẫn tạo lại được', async () => {
      const used = await report(priv, { versions: 1, regenerateCount: 3 });
      const skipped = await report(priv, { status: 'skipped' });
      const failed = await report(priv, { versions: 1, status: 'failed', regenerateCount: 1 });
      const limit = await http()
        .post(url(priv, `/${used.weekStart}/regenerate`))
        .set(as(ca!));
      const fromSkipped = await http()
        .post(url(priv, `/${skipped.weekStart}/regenerate`))
        .set(as(ca!));
      const fromFailed = await http()
        .post(url(priv, `/${failed.weekStart}/regenerate`))
        .set(as(ca!));
      expect([
        limit.status,
        limit.body.error.code,
        fromSkipped.status,
        fromFailed.status,
        fromFailed.body.data.regenerateCount,
      ]).toEqual([409, 'REPORT_REGENERATE_LIMIT', 202, 202, 2]);
    });

    it('kênh lưu trữ → 409 CHANNEL_ARCHIVED; tuần chưa có báo cáo → 404', async () => {
      const ch = (await insertChannel(db, orgId, co!.id, { visibility: 'private' })).id;
      const r = await report(ch, { versions: 1 });
      await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch));
      const archived = await http()
        .post(url(ch, `/${r.weekStart}/regenerate`))
        .set(as(co!));
      const missing = await http().post(url(priv, '/2031-01-06/regenerate')).set(as(co!));
      expect([archived.status, archived.body.error.code, missing.status]).toEqual([
        409,
        'CHANNEL_ARCHIVED',
        404,
      ]);
      // Lưu trữ = chỉ đọc: chủ kênh vẫn ĐỌC được báo cáo.
      expect(
        (
          await http()
            .get(url(ch, `/${r.weekStart}`))
            .set(as(co!))
        ).status,
      ).toBe(200);
    });

    // Đột biến: bỏ `.for('update')` ở `lockByWeek` → cả hai cùng đọc `completed` và cùng ghi.
    it('RACE: 2 lần tạo lại SONG SONG khi count=0 → đúng một 202, một 409 IN_PROGRESS; count=1; đúng 1 job', async () => {
      const r = await report(priv, { versions: 1 });
      const results = await Promise.all([
        http()
          .post(url(priv, `/${r.weekStart}/regenerate`))
          .set(as(ca!)),
        http()
          .post(url(priv, `/${r.weekStart}/regenerate`))
          .set(as(co!)),
      ]);
      const row = (await db.select().from(weeklyReports).where(eq(weeklyReports.id, r.id)))[0]!;
      const jobs = await Promise.all([1, 2].map((g) => queue.getJob(reportJobId(r.id, g))));
      expect([
        results.map((x) => x.status).sort((a, b) => a - b),
        row.regenerateCount,
        jobs.map(Boolean),
      ]).toEqual([[202, 409], 1, [true, false]]);
      expect(results.find((x) => x.status === 409)?.body.error.code).toBe('REPORT_IN_PROGRESS');
    });

    // Đột biến cùng chỗ: không khoá thì lần thứ hai ghi count = 4 → CHECK 0..3 → 500 thay vì 409 (03 §5).
    it('RACE ở ranh giới quota: count=2 → một 202 (count=3), một 409; KHÔNG 500 từ CHECK', async () => {
      const r = await report(priv, { versions: 1, regenerateCount: 2 });
      const results = await Promise.all([
        http()
          .post(url(priv, `/${r.weekStart}/regenerate`))
          .set(as(ca!)),
        http()
          .post(url(priv, `/${r.weekStart}/regenerate`))
          .set(as(co!)),
      ]);
      const row = (await db.select().from(weeklyReports).where(eq(weeklyReports.id, r.id)))[0]!;
      expect([results.map((x) => x.status).sort((a, b) => a - b), row.regenerateCount]).toEqual([
        [202, 409],
        3,
      ]);
    });

    // Cuối file: worker này nhận cả job còn sót của các test trên (vô hại — chúng chỉ đổi dòng của chính chúng).
    it('đầu-cuối với worker: tạo lại → phiên bản mới (manual + người bấm) trở thành bản hiển thị', async () => {
      const ch = (await insertChannel(db, orgId, co!.id, { visibility: 'private' })).id;
      await addChannelMember(db, { id: ch }, orgId, ca!.id, 'admin');
      const week = '2026-10-05';
      for (let i = 0; i < 2; i++) {
        const m = await insertMeeting(db, orgId, co!.id, {
          title: `Họp ${i}`,
          recordedAt: new Date(Date.UTC(2026, 9, 6, i + 1)),
          status: 'completed',
        });
        await shareMeeting(db, orgId, m.id, ch);
        await db.insert(meetingSummaries).values({
          meetingId: m.id,
          orgId,
          content: { overview: `Tóm tắt ${i}`, keyPoints: [], decisions: [], actionItems: [] },
          model: 'fake',
          promptVersion: 'v1',
          inputTokens: 1,
          outputTokens: 1,
        });
      }
      await report(ch, { weekStart: week, versions: 1 });
      workers.push(await createTestWorker({ reportWriter: new FakeReportWriter() }));
      await http()
        .post(url(ch, `/${week}/regenerate`))
        .set(as(ca!))
        .expect(202);
      await vi.waitFor(
        async () => {
          const res = await http()
            .get(url(ch, `/${week}`))
            .set(as(ca!));
          expect([res.body.data.status, res.body.data.currentVersion]).toEqual(['completed', 2]);
        },
        { timeout: 20_000, interval: 100 },
      );
      const versions = await http()
        .get(url(ch, `/${week}/versions`))
        .set(as(ca!))
        .expect(200);
      expect(
        versions.body.data.map(
          (v: { version: number; trigger: string; triggeredBy: string | null }) => [
            v.version,
            v.trigger,
            v.triggeredBy,
          ],
        ),
      ).toEqual([
        [2, 'manual', ca!.id],
        [1, 'scheduled', null],
      ]);
      expect(versions.body.data[0].content.meetings).toHaveLength(2);
    });
  });
});
