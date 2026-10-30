import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { actionItems, orgDailyStats } from '../../../../src/infra/database/schema/index.js';
import { DashboardLiveRepository } from '../../../../src/modules/dashboard/repositories/dashboard-live.repository.js';
import { DashboardRepository } from '../../../../src/modules/dashboard/repositories/dashboard.repository.js';
import { DashboardService } from '../../../../src/modules/dashboard/services/dashboard.service.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUpload,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const NOW = new Date('2026-10-29T05:00:00Z'); // 12:00 ngày 29 giờ VN (Thứ Năm)
const TITLE = 'TIÊU ĐỀ-BÍ-MẬT-XYZ';
const TASK = 'VIỆC-BÍ-MẬT-XYZ';

/** Ghép rollup + số trực tiếp (M17 B4) trên Postgres thật: một tổ chức dựng tay, kiểm từng khối số. */
describe('DashboardService.overview (Postgres thật)', () => {
  let t: TestDb;
  let rollup: DashboardRepository;
  let service: DashboardService;
  let orgId: string;
  let otherOrgId: string;
  let ownerId: string;
  let memberId: string;

  beforeAll(async () => {
    t = createTestDb();
    rollup = new DashboardRepository(t.db);
    service = new DashboardService(rollup, new DashboardLiveRepository(t.db));
    ownerId = (await insertUser(t.db)).id;
    memberId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
    await addMember(t.db, orgId, memberId);
    const otherOwner = (await insertUser(t.db)).id;
    otherOrgId = (await insertOrg(t.db, otherOwner)).id;

    const channel = await insertChannel(t.db, orgId, ownerId, { name: 'kenh-chinh' });
    const mk = async (
      owner: string,
      at: string,
      over: Parameters<typeof insertMeeting>[3] = {},
    ) => {
      const m = await insertMeeting(t.db, orgId, owner, {
        title: TITLE,
        recordedAt: new Date(at),
        status: 'completed',
        durationMs: 60_000,
        ...over,
      });
      await shareMeeting(t.db, orgId, m.id, channel.id);
      return m.id;
    };
    // Tuần 10-26 → 11-01 (Thứ Hai → CN)
    const a = await mk(ownerId, '2026-10-27T03:00:00Z', { durationMs: 600_000 });
    await mk(memberId, '2026-10-27T05:00:00Z', {
      status: 'failed',
      failureCode: 'TRANSCRIBE_FAILED',
      durationMs: 120_000,
    });
    await mk(ownerId, '2026-10-28T03:00:00Z', { durationMs: 300_000 });
    await mk(ownerId, '2026-10-28T04:00:00Z', { status: 'transcribing', durationMs: null });
    await mk(ownerId, '2026-10-28T06:00:00Z', { deletedAt: new Date() }); // đã xoá
    await mk(ownerId, '2026-09-01T03:00:00Z'); // ngoài khoảng mặc định (30 ngày)
    await t.db.insert(actionItems).values([
      { orgId, meetingId: a, origin: 'manual', task: TASK, dueDate: '2026-10-20' }, // quá hạn
      { orgId, meetingId: a, origin: 'manual', task: TASK, dueDate: '2026-10-29' }, // hôm nay: chưa
      { orgId, meetingId: a, origin: 'manual', task: TASK, status: 'dismissed' },
    ]);
    await insertUpload(t.db, orgId, ownerId, {
      sizeBytes: 5_000_000,
      totalParts: 1,
      status: 'completed',
      meetingId: a,
      completedAt: new Date(),
    });
    // org khác: số liệu giống hệt để thử lẫn
    await insertMeeting(t.db, otherOrgId, otherOwner, {
      recordedAt: new Date('2026-10-27T03:00:00Z'),
      status: 'completed',
      durationMs: 999_000,
    });
    for (const d of ['2026-10-27', '2026-10-28', '2026-09-01']) await rollup.rollupDay(orgId, d);
    await rollup.rollupDay(otherOrgId, '2026-10-27');
  });

  afterAll(async () => {
    await t.close();
  });

  it('mặc định 30 ngày tới hôm nay: tổng, tỉ lệ lỗi, phút, và ngày trống điền 0', async () => {
    const o = await service.overview(orgId, {}, NOW);
    expect(o.range).toEqual({ from: '2026-09-30', to: '2026-10-29' });
    expect(o.granularity).toBe('day');
    expect(o.series).toHaveLength(30);
    expect(o.totals).toEqual({
      meetings: 4, // 2026-10-27 ×2 + 10-28 ×2 (đã xoá và 09-01 không tính)
      completed: 2,
      failed: 1,
      failureRate: 0.3333, // 1 / (2 + 1); meeting đang xử lý không vào mẫu số
      recordedMinutes: 17, // (600 + 120 + 300 + 0 s) = 1020 s = 17 phút
      transcribedMinutes: 15, // chỉ meeting completed: 900 s
    });
    const byPeriod = new Map(o.series.map((p) => [p.period, p]));
    expect(byPeriod.get('2026-10-27')).toMatchObject({ meetings: 2, completed: 1, failed: 1 });
    expect(byPeriod.get('2026-10-28')).toMatchObject({ meetings: 2, completed: 1, failed: 0 });
    expect(byPeriod.get('2026-10-29')).toMatchObject({ meetings: 0 }); // hôm nay: ngày trống
  });

  it('các khối tính trực tiếp được nối đúng: thành viên, dung lượng, top kênh, việc', async () => {
    const o = await service.overview(orgId, {}, NOW);
    expect(o.members).toEqual({ total: 2, active: 2 });
    expect(o.storage).toEqual({ bytes: 5_000_000, meetings: 1 });
    expect(o.topChannels).toEqual([
      { channelId: expect.any(String), name: 'kenh-chinh', meetings: 4 },
    ]);
    expect(o.actionItems).toEqual({ open: 2, overdue: 1, doneInRange: 0 });
  });

  it('theo tuần: gom Thứ Hai, tổng tuần KHỚP tổng ngày và tổng cả khoảng', async () => {
    const day = await service.overview(orgId, { granularity: 'day' }, NOW);
    const week = await service.overview(orgId, { granularity: 'week' }, NOW);
    const sum = (o: typeof day, k: 'meetings' | 'recordedMinutes') =>
      o.series.reduce((s, p) => s + p[k], 0);
    expect(week.series.find((p) => p.period === '2026-10-26')).toMatchObject({ meetings: 4 });
    expect(sum(week, 'meetings')).toBe(sum(day, 'meetings'));
    expect(sum(week, 'meetings')).toBe(week.totals.meetings);
    expect(week.totals).toEqual(day.totals);
    expect(week.granularity).toBe('week');
  });

  it('khoảng tuỳ chọn: chỉ tính ngày trong khoảng; thành viên hoạt động theo khoảng', async () => {
    const o = await service.overview(orgId, { from: '2026-10-28', to: '2026-10-28' }, NOW);
    expect(o.series).toHaveLength(1);
    expect(o.totals.meetings).toBe(2);
    expect(o.members).toEqual({ total: 2, active: 1 }); // 10-28 chỉ có owner
    expect(o.actionItems.doneInRange).toBe(0);
  });

  it('computedAt = lần tính gần nhất trong khoảng; chưa ngày nào được tính → null', async () => {
    const o = await service.overview(orgId, {}, NOW);
    expect(o.computedAt).not.toBeNull();
    expect(new Date(o.computedAt!).getTime()).toBeLessThanOrEqual(Date.now());
    const empty = await service.overview(orgId, { from: '2026-10-01', to: '2026-10-05' }, NOW);
    expect(empty.computedAt).toBeNull();
    expect(empty.totals).toMatchObject({ meetings: 0, failureRate: null });
    expect(empty.series).toHaveLength(5);
  });

  it('không lẫn tổ chức, và KHÔNG chứa tiêu đề meeting / nội dung việc (D2)', async () => {
    const o = await service.overview(orgId, {}, NOW);
    expect(o.totals.recordedMinutes).toBe(17); // không cộng 999 s của org khác
    const other = await service.overview(otherOrgId, {}, NOW);
    expect(other.totals).toMatchObject({
      meetings: 1,
      recordedMinutes: 17,
      transcribedMinutes: 17,
    }); // 999 s = 16,65 phút
    const json = JSON.stringify(o);
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(TASK);
  });

  // Đột biến: lấy "hôm nay" theo UTC → 18:00Z ngày 29 vẫn ra 29, trong khi giờ VN đã là 01:00 ngày 30.
  it('"hôm nay" theo GIỜ VN: 18:00Z ngày 29 là 01:00 ngày 30 → khoảng mặc định kết thúc ở ngày 30', async () => {
    const o = await service.overview(orgId, {}, new Date('2026-10-29T18:00:00Z'));
    expect(o.range.to).toBe('2026-10-30');
    expect(o.series.at(-1)!.period).toBe('2026-10-30');
  });

  // Đột biến: `computedAt` lấy mốc NHỎ nhất thay vì lớn nhất; top kênh luôn 1; tổng cộng từ chuỗi đã làm tròn.
  describe('tổ chức nhiều dữ liệu', () => {
    let org: string;
    let owner: string;

    beforeAll(async () => {
      owner = (await insertUser(t.db)).id;
      org = (await insertOrg(t.db, owner)).id;
      // 3 ngày, mỗi ngày một meeting 40 s: mỗi ngày làm tròn 1 phút → cộng ngày = 3, đúng = 120 s = 2 phút
      for (const d of ['2026-10-20', '2026-10-21', '2026-10-22']) {
        await insertMeeting(t.db, org, owner, {
          recordedAt: new Date(`${d}T03:00:00Z`),
          status: 'completed',
          durationMs: 40_000,
        });
        await rollup.rollupDay(org, d);
      }
      // 7 kênh với số meeting khác nhau (kênh i có i meeting trong khoảng)
      for (let i = 1; i <= 7; i++) {
        const ch = await insertChannel(t.db, org, owner, { name: `kenh-${i}` });
        for (let k = 0; k < i; k++) {
          const m = await insertMeeting(t.db, org, owner, {
            recordedAt: new Date('2026-10-23T03:00:00Z'),
            status: 'completed',
            durationMs: 1000,
          });
          await shareMeeting(t.db, org, m.id, ch.id);
        }
      }
      await t.db.execute(
        sql`update ${orgDailyStats} set computed_at = '2026-10-20T00:00:00Z' where org_id = ${org} and day = '2026-10-20'`,
      );
      await t.db.execute(
        sql`update ${orgDailyStats} set computed_at = '2026-10-25T00:00:00Z' where org_id = ${org} and day = '2026-10-21'`,
      );
      await t.db.execute(
        sql`update ${orgDailyStats} set computed_at = '2026-10-22T00:00:00Z' where org_id = ${org} and day = '2026-10-22'`,
      );
    });

    it('computedAt là mốc MỚI nhất trong các ngày của khoảng', async () => {
      const o = await service.overview(org, { from: '2026-10-20', to: '2026-10-22' }, NOW);
      expect(o.computedAt).toBe('2026-10-25T00:00:00.000Z');
    });

    it('top kênh: đúng 5, nhiều meeting nhất trước', async () => {
      const o = await service.overview(org, { from: '2026-10-23', to: '2026-10-23' }, NOW);
      expect(o.topChannels.map((c) => [c.name, c.meetings])).toEqual([
        ['kenh-7', 7],
        ['kenh-6', 6],
        ['kenh-5', 5],
        ['kenh-4', 4],
        ['kenh-3', 3],
      ]);
    });

    it('tổng phút tính từ mili giây của các ngày, KHÔNG cộng các số phút đã làm tròn', async () => {
      const o = await service.overview(org, { from: '2026-10-20', to: '2026-10-22' }, NOW);
      expect(o.series.map((p) => p.recordedMinutes)).toEqual([1, 1, 1]); // làm tròn từng ngày
      expect(o.totals.recordedMinutes).toBe(2); // 120 s
    });
  });

  it('khoảng sai → 400 (ví dụ 93 ngày, từ > đến, ngoài cửa sổ 92 ngày)', async () => {
    for (const q of [
      { from: '2026-07-28', to: '2026-10-29' },
      { from: '2026-10-10', to: '2026-10-09' },
      { from: '2026-07-01', to: '2026-07-02' },
      { from: '2026-02-30' },
    ]) {
      await expect(service.overview(orgId, q, NOW)).rejects.toMatchObject({ status: 400 });
    }
  });
});
