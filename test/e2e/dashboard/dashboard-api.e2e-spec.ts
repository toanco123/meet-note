import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { actionItems, users } from '../../../src/infra/database/schema/index.js';
import { DashboardRepository } from '../../../src/modules/dashboard/repositories/dashboard.repository.js';
import { StatsRollupService } from '../../../src/modules/dashboard/services/stats-rollup.service.js';
import { addDays, localDate } from '../../../src/modules/reports/report-week.js';
import { createTestApp } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  insertUpload,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

const SECRET_TITLE = 'TIÊU-ĐỀ-HọP-BÍ-MẬT-QWERTY';
const SECRET_TASK = 'NỘI-DUNG-VIỆC-BÍ-MẬT-QWERTY';

interface Overview {
  range: { from: string; to: string };
  granularity: string;
  totals: Record<string, number | null>;
  series: Array<{ period: string; meetings: number }>;
  members: { total: number; active: number };
  storage: { bytes: number; meetings: number };
  topChannels: Array<{ channelId: string; name: string; meetings: number }>;
  actionItems: { open: number; overdue: number; doneInRange: number };
  computedAt: string | null;
}

/** API dashboard (M17 B5): quyền, đầu vào, số liệu, không rò tiêu đề / nội dung / tên người. */
describe('GET /orgs/:orgId/dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let rollup: StatsRollupService;
  let orgId: string;
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  const today = localDate(new Date());
  const day1 = addDays(today, -2);
  const day2 = addDays(today, -1);
  let meetingToDelete: string;
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);
  const get = (u: TestUser, query: Record<string, string> = {}, org = orgId) =>
    http().get(`/v1/orgs/${org}/dashboard`).query(query).set(as(u));
  const data = (res: request.Response) => res.body.data as Overview;

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    rollup = new StatsRollupService(db, new DashboardRepository(db));
    [owner, admin, member, outsider] = (await Promise.all(
      Array.from({ length: 4 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Số liệu' }).expect(201))
      .body.data.id as string;
    await addMember(db, orgId, admin.id, 'admin');
    await addMember(db, orgId, member.id);

    const priv = await insertChannel(db, orgId, owner.id, {
      name: 'kenh-rieng-tu',
      visibility: 'private',
    });
    const mk = async (at: string, over: Parameters<typeof insertMeeting>[3] = {}) => {
      const m = await insertMeeting(db, orgId, member.id, {
        title: SECRET_TITLE,
        recordedAt: new Date(at),
        status: 'completed',
        durationMs: 600_000,
        ...over,
      });
      await shareMeeting(db, orgId, m.id, priv.id);
      return m.id;
    };
    const first = await mk(`${day1}T03:00:00Z`);
    meetingToDelete = await mk(`${day1}T05:00:00Z`);
    await mk(`${day2}T03:00:00Z`, {
      status: 'failed',
      failureCode: 'TRANSCRIBE_FAILED',
      durationMs: 60_000,
    });
    await db.insert(actionItems).values([
      { orgId, meetingId: first, origin: 'manual', task: SECRET_TASK, dueDate: addDays(today, -5) },
      { orgId, meetingId: first, origin: 'manual', task: SECRET_TASK },
    ]);
    await insertUpload(db, orgId, member.id, {
      sizeBytes: 7_000_000,
      totalParts: 1,
      status: 'completed',
      meetingId: first,
      completedAt: new Date(),
    });
    for (const d of [day1, day2]) await rollup.rollupDay(orgId, d);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('quyền', () => {
    it.each([
      ['Owner', () => owner, 200],
      ['Admin', () => admin, 200],
      ['Member', () => member, 403],
      ['người ngoài tổ chức', () => outsider, 404],
    ] as const)('%s → %i', async (_name, who, status) => {
      expect((await get(who())).status).toBe(status);
    });

    it('chưa đăng nhập → 401', async () => {
      const res = await http().get(`/v1/orgs/${orgId}/dashboard`);
      expect(res.status).toBe(401);
    });

    it('Member bị 403 với cả đầu vào sai (quyền xét trước đầu vào)', async () => {
      const res = await get(member, { from: 'sai' });
      expect(res.status).toBe(403);
    });

    it('Owner của tổ chức KHÁC không xem được tổ chức này (404)', async () => {
      const other = await registerUser(app);
      await http().post('/v1/orgs').set(as(other)).send({ name: 'Tổ chức khác' }).expect(201);
      expect((await get(other)).status).toBe(404);
    });
  });

  describe('số liệu', () => {
    it('mặc định 30 ngày tới hôm nay: đủ 30 điểm, tổng và các khối đúng', async () => {
      const res = await get(admin).expect(200);
      const o = data(res);
      expect(o.range).toEqual({ from: addDays(today, -29), to: today });
      expect(o.granularity).toBe('day');
      expect(o.series).toHaveLength(30);
      expect(o.totals).toEqual({
        meetings: 3,
        completed: 2,
        failed: 1,
        failureRate: 0.3333,
        recordedMinutes: 21, // 600 + 600 + 60 giây = 1260 s
        transcribedMinutes: 20,
      });
      expect(o.members).toEqual({ total: 3, active: 1 }); // chỉ `member` có meeting
      expect(o.storage).toEqual({ bytes: 7_000_000, meetings: 1 });
      expect(o.actionItems).toEqual({ open: 2, overdue: 1, doneInRange: 0 });
      expect(o.computedAt).not.toBeNull();
      expect(res.body.meta.statusCode).toBe(200); // bọc đúng phong bì chuẩn
    });

    it('kênh riêng tư vẫn vào top kênh (Owner / Admin đã thấy mọi kênh — D2)', async () => {
      const o = data(await get(owner).expect(200));
      expect(o.topChannels).toEqual([
        { channelId: expect.any(String), name: 'kenh-rieng-tu', meetings: 3 },
      ]);
    });

    it('tuần cho cùng tổng với ngày; điểm của tuần được dán nhãn bằng Thứ Hai', async () => {
      const day = data(await get(owner).expect(200));
      const week = data(await get(owner, { granularity: 'week' }).expect(200));
      expect(week.granularity).toBe('week');
      expect(week.totals).toEqual(day.totals);
      const sum = (s: Overview['series']) => s.reduce((a, p) => a + p.meetings, 0);
      expect(sum(week.series)).toBe(sum(day.series));
      for (const p of week.series) {
        const monday = new Date(`${p.period}T00:00:00Z`).getUTCDay();
        expect(monday).toBe(1);
      }
    });

    it('khoảng tuỳ chọn một ngày', async () => {
      const o = data(await get(owner, { from: day2, to: day2 }).expect(200));
      expect(o.series).toEqual([
        {
          period: day2,
          meetings: 1,
          completed: 0,
          failed: 1,
          recordedMinutes: 1,
          transcribedMinutes: 0,
        },
      ]);
      expect(o.totals.failureRate).toBe(1);
    });

    it('khoảng chưa ngày nào được tính → số 0, failureRate null, computedAt null', async () => {
      const far = addDays(today, -60);
      const o = data(await get(owner, { from: far, to: far }).expect(200));
      expect(o.totals).toMatchObject({ meetings: 0, failureRate: null });
      expect(o.computedAt).toBeNull();
    });

    // Đột biến: dashboard đọc rollup nhưng rollup không được tính lại → số cũ nằm lại.
    it('xoá cuộc họp rồi rollup tính lại → số giảm đúng (api xoá, worker tính — ở đây gọi trực tiếp)', async () => {
      const before = data(await get(owner, { from: day1, to: day1 }).expect(200));
      expect(before.totals.meetings).toBe(2);
      await http()
        .delete(`/v1/orgs/${orgId}/meetings/${meetingToDelete}`)
        .set(as(member))
        .expect(204);
      await rollup.rollupDay(orgId, day1);
      const after = data(await get(owner, { from: day1, to: day1 }).expect(200));
      expect(after.totals).toMatchObject({ meetings: 1, recordedMinutes: 10 });
    });
  });

  describe('riêng tư (D2)', () => {
    it('response KHÔNG chứa tiêu đề cuộc họp, nội dung việc, tên hay email thành viên', async () => {
      const res = await get(owner).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(SECRET_TITLE);
      expect(text).not.toContain(SECRET_TASK);
      const people = await db.select({ email: users.email, name: users.displayName }).from(users);
      const identifiers = people.flatMap((p) => [p.email, ...(p.name.length > 6 ? [p.name] : [])]);
      expect(identifiers.filter((id) => text.includes(id))).toEqual([]);
    });
  });

  describe('đầu vào sai → 400 VALIDATION_FAILED', () => {
    it.each([
      ['from sai dạng', { from: '29/10/2026' }],
      ['to sai dạng', { to: 'hôm nay' }],
      ['ngày không có thật', { from: '2026-02-30' }],
      ['from sau to', { from: day2, to: day1 }],
      ['quá 92 ngày', { from: addDays(today, -92), to: today }],
      ['from cũ hơn cửa sổ 92 ngày', { from: addDays(today, -100), to: addDays(today, -99) }],
      ['granularity lạ', { granularity: 'month' }],
    ])('%s', async (_name, query) => {
      const res = await get(owner, query).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('đúng 92 ngày (biên) được; to ở tương lai được', async () => {
      await get(owner, { from: addDays(today, -91), to: today }).expect(200);
      const o = data(await get(owner, { from: today, to: addDays(today, 3) }).expect(200));
      expect(o.series).toHaveLength(4);
    });
  });
});
