import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import { orgDailyStats, organizations } from '../../../../../src/infra/database/schema/index.js';
import { insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

/** Bất biến của bảng `org_daily_stats` (M17 B1): khoá chính, CHECK, FK CASCADE, RLS. */
describe('Schema org_daily_stats (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  async function newOrg() {
    const owner = await insertUser(t.db);
    return (await insertOrg(t.db, owner.id)).id;
  }
  const row = (orgId: string, over: Partial<typeof orgDailyStats.$inferInsert> = {}) =>
    t.db.insert(orgDailyStats).values({ orgId, day: '2026-10-05', ...over });
  const codeAndConstraint = async (p: Promise<unknown>) => {
    const e = await pgErrorOf(p);
    return [e?.code, e?.constraint];
  };

  it('mặc định mọi số bằng 0; (org, ngày) là khoá chính', async () => {
    const orgId = await newOrg();
    await row(orgId);
    const [r] = await t.db.select().from(orgDailyStats).where(eq(orgDailyStats.orgId, orgId));
    expect(r).toMatchObject({
      meetingsTotal: 0,
      meetingsCompleted: 0,
      meetingsFailed: 0,
      recordedMs: 0,
      transcribedMs: 0,
    });
    expect(await codeAndConstraint(row(orgId))).toEqual(['23505', 'org_daily_stats_pk']);
    await row(orgId, { day: '2026-10-06' }); // ngày khác thì được
  });

  it.each([
    ['total âm', { meetingsTotal: -1 }],
    ['completed âm', { meetingsTotal: 5, meetingsCompleted: -1 }],
    ['failed âm', { meetingsTotal: 5, meetingsFailed: -1 }],
    ['completed + failed > total', { meetingsTotal: 2, meetingsCompleted: 2, meetingsFailed: 1 }],
  ])('CHECK counts: %s bị từ chối', async (_name, over) => {
    expect(await codeAndConstraint(row(await newOrg(), over))).toEqual([
      '23514',
      'org_daily_stats_counts_ck',
    ]);
  });

  it('completed + failed = total được (biên)', async () => {
    const orgId = await newOrg();
    await row(orgId, { meetingsTotal: 3, meetingsCompleted: 2, meetingsFailed: 1 });
    const [r] = await t.db.select().from(orgDailyStats).where(eq(orgDailyStats.orgId, orgId));
    expect([r!.meetingsTotal, r!.meetingsCompleted, r!.meetingsFailed]).toEqual([3, 2, 1]);
  });

  it.each([
    ['recorded âm', { recordedMs: -1 }],
    ['transcribed âm', { recordedMs: 10, transcribedMs: -1 }],
    ['transcribed > recorded', { recordedMs: 10, transcribedMs: 11 }],
  ])('CHECK ms: %s bị từ chối', async (_name, over) => {
    expect(await codeAndConstraint(row(await newOrg(), over))).toEqual([
      '23514',
      'org_daily_stats_ms_ck',
    ]);
  });

  it('thời lượng lớn (> 2^31 ms, ~25 ngày) vẫn lưu được: cột bigint', async () => {
    const orgId = await newOrg();
    await row(orgId, { recordedMs: 5_000_000_000, transcribedMs: 4_000_000_000 });
    const [r] = await t.db.select().from(orgDailyStats).where(eq(orgDailyStats.orgId, orgId));
    expect(r!.recordedMs).toBe(5_000_000_000);
  });

  it('FK: org không tồn tại bị từ chối; xoá org thì dòng rollup biến mất (CASCADE)', async () => {
    expect(await codeAndConstraint(row('00000000-0000-4000-8000-000000000000'))).toEqual([
      '23503',
      'org_daily_stats_org_fk',
    ]);
    const orgId = await newOrg();
    await row(orgId);
    await t.db.delete(organizations).where(eq(organizations.id, orgId));
    expect(await t.db.select().from(orgDailyStats).where(eq(orgDailyStats.orgId, orgId))).toEqual(
      [],
    );
  });

  // Đột biến: bỏ policy `org_daily_stats_org_isolation` → user api thấy số liệu tổ chức khác.
  it('RLS: user của api không ngữ cảnh / khác tổ chức không thấy; đúng tổ chức thấy; ghi sai tổ chức bị chặn', async () => {
    const [a, other] = [await newOrg(), await newOrg()];
    await row(a, { meetingsTotal: 1 });
    const api = createTestDb(1, process.env.DATABASE_URL);
    try {
      const count = async (orgId: string) => {
        await api.db.execute(sql`select set_config('app.org_id', ${orgId}, false)`);
        return (await api.db.select().from(orgDailyStats).where(eq(orgDailyStats.orgId, a))).length;
      };
      expect([await count(''), await count(other), await count(a)]).toEqual([0, 0, 1]);
      await api.db.execute(sql`select set_config('app.org_id', ${other}, false)`);
      const e = await pgErrorOf(
        api.db.insert(orgDailyStats).values({ orgId: a, day: '2026-10-07' }),
      );
      expect(e?.code).toBe('42501');
    } finally {
      await api.close();
    }
  });
});
