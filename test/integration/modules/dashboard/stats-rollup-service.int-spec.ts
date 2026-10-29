import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { meetings } from '../../../../src/infra/database/schema/index.js';
import { DashboardRepository } from '../../../../src/modules/dashboard/repositories/dashboard.repository.js';
import {
  RECONCILE_DAYS,
  StatsTickService,
  TICK_BUCKET_MS,
} from '../../../../src/modules/dashboard/services/stats-tick.service.js';
import {
  rollupLockKey,
  StatsRollupService,
} from '../../../../src/modules/dashboard/services/stats-rollup.service.js';
import type { StatsScheduler } from '../../../../src/modules/dashboard/stats.scheduler.js';
import { localDate } from '../../../../src/modules/reports/report-week.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tính lại rollup (M17 B2): span, khoá advisory tuần tự hoá, tick chọn đúng (tổ chức, ngày), job đêm. */
describe('StatsRollupService / StatsTickService (Postgres thật)', () => {
  let t: TestDb;
  let lockHolder: TestDb; // pool riêng để GIỮ khoá advisory từ "người khác"
  let repo: DashboardRepository;
  let service: StatsRollupService;

  beforeAll(() => {
    t = createTestDb(6);
    lockHolder = createTestDb(2);
    repo = new DashboardRepository(t.db);
    service = new StatsRollupService(t.db, repo);
  });

  afterAll(async () => {
    await t.close();
    await lockHolder.close();
  });

  async function newOrg() {
    const owner = (await insertUser(t.db)).id;
    return { orgId: (await insertOrg(t.db, owner)).id, owner };
  }
  const mk = (org: { orgId: string; owner: string }, recordedAt: string, over = {}) =>
    insertMeeting(t.db, org.orgId, org.owner, {
      recordedAt: new Date(recordedAt),
      status: 'completed',
      durationMs: 1000,
      ...over,
    });
  const total = async (orgId: string, day: string) =>
    (await repo.readRange(orgId, day, day))[0]?.meetingsTotal;

  describe('rollup(span)', () => {
    it('tính lại `span` ngày kết thúc ở `day` (qua tháng), không đụng ngày ngoài khoảng', async () => {
      const org = await newOrg();
      for (const at of ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
        await mk(org, `${at}T03:00:00Z`);
      expect(await service.rollup(org.orgId, '2026-03-01', 3)).toBe(3);
      const rows = await repo.readRange(org.orgId, '2026-01-01', '2026-12-31');
      expect(rows.map((r) => [r.day, r.meetingsTotal])).toEqual([
        ['2026-02-27', 1],
        ['2026-02-28', 1],
        ['2026-03-01', 1],
      ]); // 03-02 nằm sau `day` nên không có dòng
    });

    it('span mặc định 1; span bất thường bị kẹp vào [1, 92]', async () => {
      const org = await newOrg();
      expect(await service.rollup(org.orgId, '2026-05-10')).toBe(1);
      expect(await service.rollup(org.orgId, '2026-05-10', 0)).toBe(1);
      expect(await service.rollup(org.orgId, '2026-05-10', -5)).toBe(1);
      expect(await service.rollup(org.orgId, '2026-05-10', 10_000)).toBe(92);
    });
  });

  describe('khoá advisory (Q6)', () => {
    const hold = async (key: string) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      const holding = lockHolder.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        locked();
        await gate;
      });
      await lockedP;
      return { release, holding };
    };

    // Đột biến: bỏ `pg_advisory_xact_lock` → rollupDay chạy NGAY với nguồn cũ, kết thúc trước khi nguồn đổi.
    it('rollup CHỜ khi (tổ chức, ngày) đang bị khoá, rồi đọc nguồn MỚI nhất (không ghi số cũ)', async () => {
      const org = await newOrg();
      const day = '2026-06-15';
      const h = await hold(rollupLockKey(org.orgId, day));
      let finished = false;
      const run = service.rollupDay(org.orgId, day).then(() => (finished = true));
      await sleep(400);
      expect(finished).toBe(false); // bị chặn bởi khoá

      await mk(org, '2026-06-15T03:00:00Z'); // nguồn đổi TRONG lúc chờ
      h.release();
      await h.holding;
      await run;
      expect(await total(org.orgId, day)).toBe(1); // thấy meeting mới, không phải 0 của snapshot cũ
    });

    it('khoá theo (tổ chức, ngày): ngày khác / tổ chức khác KHÔNG chờ', async () => {
      const org = await newOrg();
      const other = await newOrg();
      const h = await hold(rollupLockKey(org.orgId, '2026-06-15'));
      try {
        const done = (p: Promise<unknown>) =>
          Promise.race([p.then(() => true), sleep(3000).then(() => false)]);
        expect(await done(service.rollupDay(org.orgId, '2026-06-16'))).toBe(true);
        expect(await done(service.rollupDay(other.orgId, '2026-06-15'))).toBe(true);
      } finally {
        h.release();
        await h.holding;
      }
    });

    it('nhiều lần tính lại song song cùng (tổ chức, ngày) → kết quả cuối khớp nguồn, không lỗi', async () => {
      const org = await newOrg();
      const day = '2026-06-22';
      await Promise.all(Array.from({ length: 4 }, (_, i) => mk(org, `${day}T0${i + 1}:00:00Z`)));
      await Promise.all(Array.from({ length: 12 }, () => service.rollupDay(org.orgId, day)));
      expect(await total(org.orgId, day)).toBe(4);
    });
  });

  describe('tick (mỗi 5 phút)', () => {
    const fake = () => {
      const enqueueRollup = vi.fn<StatsScheduler['enqueueRollup']>().mockResolvedValue();
      return { scheduler: { enqueueRollup } as unknown as StatsScheduler, enqueueRollup };
    };
    const ageMeeting = (id: string, minutes: number) =>
      t.db.execute(
        sql`update ${meetings} set updated_at = now() - make_interval(mins => ${minutes}) where id = ${id}`,
      );
    const callsFor = (
      calls: Array<[Parameters<StatsScheduler['enqueueRollup']>[0], string]>,
      orgId: string,
    ) => calls.filter(([job]) => job.orgId === orgId).map(([job, suffix]) => ({ ...job, suffix }));

    it('chỉ meeting đổi trong 10 phút qua; lấy NGÀY CỦA MEETING (không phải hôm nay); gộp cùng ngày', async () => {
      const org = await newOrg();
      await mk(org, '2026-03-02T03:00:00Z');
      await mk(org, '2026-03-02T05:00:00Z'); // cùng ngày → gộp
      await mk(org, '2026-02-10T03:00:00Z'); // họp từ lâu nhưng vừa đổi trạng thái
      const stale = await mk(org, '2026-01-05T03:00:00Z');
      const justInside = await mk(org, '2026-01-06T03:00:00Z');
      const justOutside = await mk(org, '2026-01-07T03:00:00Z');
      await ageMeeting(stale.id, 120);
      await ageMeeting(justInside.id, 9);
      await ageMeeting(justOutside.id, 11);

      const { scheduler, enqueueRollup } = fake();
      const now = new Date();
      const out = await new StatsTickService(repo, scheduler).tick(now);
      const mine = callsFor(enqueueRollup.mock.calls as never, org.orgId);
      const bucket = Math.floor(now.getTime() / TICK_BUCKET_MS);
      expect(mine.map((c) => c.day).sort()).toEqual(['2026-01-06', '2026-02-10', '2026-03-02']);
      expect(mine.every((c) => c.suffix === `t${bucket}`)).toBe(true);
      expect(mine.every((c) => c.span === undefined)).toBe(true);
      expect(out.enqueued).toBeGreaterThanOrEqual(3);
    });

    it('biên ngày theo GIỜ VN: 16:59:59Z và 17:00:00Z ra hai ngày khác nhau', async () => {
      const org = await newOrg();
      await mk(org, '2026-04-09T16:59:59Z');
      await mk(org, '2026-04-09T17:00:00Z');
      const { scheduler, enqueueRollup } = fake();
      await new StatsTickService(repo, scheduler).tick();
      expect(
        callsFor(enqueueRollup.mock.calls as never, org.orgId)
          .map((c) => c.day)
          .sort(),
      ).toEqual(['2026-04-09', '2026-04-10']);
    });

    it('meeting đã xoá mềm vẫn được tính lại (số phải GIẢM); mỗi tổ chức có job riêng', async () => {
      const a = await newOrg();
      const b = await newOrg();
      const m = await mk(a, '2026-05-04T03:00:00Z');
      await t.db
        .update(meetings)
        .set({ deletedAt: new Date() })
        .where(sql`id = ${m.id}`);
      await mk(b, '2026-05-04T03:00:00Z');
      const { scheduler, enqueueRollup } = fake();
      await new StatsTickService(repo, scheduler).tick();
      const calls = enqueueRollup.mock.calls as never;
      expect(callsFor(calls, a.orgId).map((c) => c.day)).toEqual(['2026-05-04']);
      expect(callsFor(calls, b.orgId).map((c) => c.day)).toEqual(['2026-05-04']);
    });

    // Đột biến: `>` thay `>=` → meeting đổi ĐÚNG vào mốc `since` bị bỏ sót.
    it('findChangedDays: meeting đổi đúng vào mốc `since` vẫn được lấy (biên dưới bao gồm)', async () => {
      const org = await newOrg();
      const m = await mk(org, '2026-09-09T03:00:00Z');
      await t.db.execute(
        sql`update ${meetings} set updated_at = '2026-10-28T12:00:00.000Z' where id = ${m.id}`,
      );
      const at = (iso: string) => repo.findChangedDays(new Date(iso), 1_000_000);
      const mine = async (iso: string) => (await at(iso)).filter((p) => p.orgId === org.orgId);
      expect(await mine('2026-10-28T12:00:00.000Z')).toHaveLength(1); // đúng mốc
      expect(await mine('2026-10-28T12:00:00.001Z')).toHaveLength(0); // sau mốc 1 ms
    });

    it('findChangedDays: `limit` chặn đợt thay đổi hàng loạt', async () => {
      const org = await newOrg();
      for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) await mk(org, `${d}T03:00:00Z`);
      const all = await repo.findChangedDays(new Date(Date.now() - 600_000), 1_000_000);
      const mineAll = all.filter((p) => p.orgId === org.orgId);
      expect(mineAll).toHaveLength(3);
      expect(await repo.findChangedDays(new Date(Date.now() - 600_000), 1)).toHaveLength(1);
    });
  });

  describe('job đêm (reconcile)', () => {
    it('MỘT job cho mỗi tổ chức: ngày = hôm nay giờ VN, span 35, jobId theo ngày', async () => {
      const org = await newOrg();
      const enqueueRollup = vi.fn<StatsScheduler['enqueueRollup']>().mockResolvedValue();
      const now = new Date('2026-10-28T20:00:00Z'); // 03:00 ngày 29 giờ VN
      await new StatsTickService(repo, { enqueueRollup } as unknown as StatsScheduler).reconcile(
        now,
      );
      const mine = enqueueRollup.mock.calls.filter(([job]) => job.orgId === org.orgId);
      expect(mine).toHaveLength(1);
      expect(mine[0]![0]).toMatchObject({ day: '2026-10-29', span: RECONCILE_DAYS });
      expect(localDate(now)).toBe('2026-10-29');
      expect(mine[0]![1]).toBe('n2026-10-29');
    });

    // Đột biến: `break` sau trang đầu → chỉ 500 tổ chức đầu được tính lại, phần còn lại không bao giờ.
    it('duyệt NHIỀU trang tổ chức (lô nhỏ): mọi tổ chức đều có job, mỗi tổ chức đúng một lần', async () => {
      const created = [
        await newOrg(),
        await newOrg(),
        await newOrg(),
        await newOrg(),
        await newOrg(),
      ].map((o) => o.orgId);
      const enqueueRollup = vi.fn<StatsScheduler['enqueueRollup']>().mockResolvedValue();
      await new StatsTickService(repo, { enqueueRollup } as unknown as StatsScheduler).reconcile(
        new Date('2026-10-28T20:00:00Z'),
        2, // lô 2 → ít nhất 3 trang cho 5 tổ chức mới (còn tổ chức của các test khác)
      );
      const ids = enqueueRollup.mock.calls.map(([job]) => job.orgId);
      expect(new Set(ids).size).toBe(ids.length); // không lặp
      for (const id of created) expect(ids.filter((x) => x === id)).toHaveLength(1);
    });

    it('listOrgIds: keyset theo id, đủ mọi tổ chức, không lặp / sót', async () => {
      const created = [await newOrg(), await newOrg(), await newOrg()].map((o) => o.orgId);
      const seen: string[] = [];
      for (let after: string | undefined; ;) {
        const page = await repo.listOrgIds(after, 2);
        seen.push(...page);
        if (page.length < 2) break;
        after = page[page.length - 1];
      }
      expect(new Set(seen).size).toBe(seen.length); // không lặp
      expect([...seen]).toEqual([...seen].sort()); // tăng dần
      for (const id of created) expect(seen).toContain(id);
    });
  });
});
