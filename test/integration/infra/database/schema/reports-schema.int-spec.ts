import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  channels,
  notifications,
  users,
  weeklyReports,
  weeklyReportVersions,
} from '../../../../../src/infra/database/schema/index.js';
import { insertChannel, insertOrg, insertUser } from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

const MONDAY = '2026-10-05';

/** Bất biến của `weekly_reports` / `weekly_report_versions` (M9 B1). */
describe('Schema báo cáo tuần (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb(); // user worker (BYPASSRLS) — dựng dữ liệu như tick của worker
  });

  afterAll(async () => {
    await t.close();
  });

  async function channelInNewOrg() {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const channel = await insertChannel(t.db, org.id, owner.id);
    return { orgId: org.id, channelId: channel.id, ownerId: owner.id };
  }
  const report = (
    c: { orgId: string; channelId: string },
    over: Partial<typeof weeklyReports.$inferInsert> = {},
  ) =>
    t.db
      .insert(weeklyReports)
      .values({ channelId: c.channelId, orgId: c.orgId, weekStart: MONDAY, ...over })
      .returning();
  const version = (
    r: { id: string; orgId: string },
    over: Partial<typeof weeklyReportVersions.$inferInsert> = {},
  ) =>
    t.db.insert(weeklyReportVersions).values({
      reportId: r.id,
      orgId: r.orgId,
      version: 1,
      trigger: 'scheduled',
      content: { overview: 'x' },
      meetingIds: [],
      model: 'fake',
      promptVersion: 'v1',
      inputTokens: 0,
      outputTokens: 0,
      ...over,
    });
  const codeOf = async (promise: Promise<unknown>) => {
    const e = await pgErrorOf(promise);
    return [e?.code, e?.constraint];
  };

  it('khoá idempotency (channel_id, week_start): chèn lần hai → 23505; `ON CONFLICT DO NOTHING` trả rỗng', async () => {
    const c = await channelInNewOrg();
    const [first] = await report(c);
    const dup = await codeOf(report(c));
    const again = await t.db
      .insert(weeklyReports)
      .values({ channelId: c.channelId, orgId: c.orgId, weekStart: MONDAY })
      .onConflictDoNothing({ target: [weeklyReports.channelId, weeklyReports.weekStart] })
      .returning({ id: weeklyReports.id });
    expect([dup, again, first?.weekStart, first?.status, first?.regenerateCount]).toEqual([
      ['23505', 'weekly_reports_channel_week_uq'],
      [],
      MONDAY, // cột `date` đọc về dạng chuỗi — không qua Date nên không lệch múi giờ
      'pending',
      0,
    ]);
  });

  it('CHECK: tuần phải bắt đầu Thứ Hai; quota 0–3; trạng thái hợp lệ; `completed` phải có bản hiển thị', async () => {
    const c = await channelInNewOrg();
    expect([
      await codeOf(report(c, { weekStart: '2026-10-06' })), // Thứ Ba
      await codeOf(report(c, { weekStart: '2026-10-04' })), // Chủ nhật
      await codeOf(report(c, { regenerateCount: 4 })),
      await codeOf(report(c, { regenerateCount: -1 })),
      await codeOf(report(c, { status: 'bogus' as never })),
      await codeOf(report(c, { status: 'completed' })),
      await codeOf(report(c, { currentVersion: 0 })),
    ]).toEqual([
      ['23514', 'weekly_reports_monday_ck'],
      ['23514', 'weekly_reports_monday_ck'],
      ['23514', 'weekly_reports_regenerate_ck'],
      ['23514', 'weekly_reports_regenerate_ck'],
      ['23514', 'weekly_reports_status_ck'],
      ['23514', 'weekly_reports_completed_ck'],
      ['23514', 'weekly_reports_version_ck'],
    ]);
    // Biên hợp lệ: 3 lần là tối đa được phép.
    const [ok] = await report(c, { regenerateCount: 3, status: 'completed', currentVersion: 1 });
    expect(ok?.regenerateCount).toBe(3);
  });

  it('composite FK: org_id lệch kênh → 23503; version lệch org → 23503; (report_id, version) trùng → 23505', async () => {
    const [c, other] = [await channelInNewOrg(), await channelInNewOrg()];
    const wrongOrg = await codeOf(report({ channelId: c.channelId, orgId: other.orgId }));
    const [r] = await report(c);
    const wrongVersionOrg = await codeOf(version({ id: r!.id, orgId: other.orgId }));
    await version(r!);
    const dupVersion = await codeOf(version(r!));
    const badVersion = await codeOf(version(r!, { version: 0 }));
    const badTrigger = await codeOf(version(r!, { version: 2, trigger: 'x' as never }));
    expect([wrongOrg, wrongVersionOrg, dupVersion, badVersion, badTrigger]).toEqual([
      ['23503', 'weekly_reports_channel_fk'],
      ['23503', 'weekly_report_versions_report_fk'],
      ['23505', 'weekly_report_versions_report_version_uq'],
      ['23514', 'weekly_report_versions_version_ck'],
      ['23514', 'weekly_report_versions_trigger_ck'],
    ]);
  });

  it('xoá cứng kênh → báo cáo + phiên bản bị xoá theo (cascade); xoá người bấm → version giữ, triggered_by NULL', async () => {
    const c = await channelInNewOrg();
    const clicker = await insertUser(t.db);
    const [r] = await report(c);
    await version(r!, { version: 1, trigger: 'manual', triggeredBy: clicker.id });
    await t.db.delete(users).where(eq(users.id, clicker.id));
    const kept = await t.db
      .select({ triggeredBy: weeklyReportVersions.triggeredBy })
      .from(weeklyReportVersions)
      .where(eq(weeklyReportVersions.reportId, r!.id));

    await t.db.delete(channels).where(eq(channels.id, c.channelId));
    const left = await t.db.execute<{ n: number }>(sql`
      select (select count(*) from weekly_reports where id = ${r!.id})
           + (select count(*) from weekly_report_versions where report_id = ${r!.id}) as n`);
    expect([kept, Number(left.rows[0]?.n)]).toEqual([[{ triggeredBy: null }], 0]);
  });

  // Đột biến: bỏ policy của weekly_reports / weekly_report_versions → user api thấy báo cáo tổ chức khác.
  it('RLS: user của api không ngữ cảnh / khác tổ chức không thấy báo cáo lẫn phiên bản; đúng tổ chức thì thấy', async () => {
    const [c, other] = [await channelInNewOrg(), await channelInNewOrg()];
    const [r] = await report(c);
    await version(r!);
    const api = createTestDb(1, process.env.DATABASE_URL); // max 1 → set_config áp cho câu sau
    try {
      const count = async (orgId: string) => {
        await api.db.execute(sql`select set_config('app.org_id', ${orgId}, false)`);
        const [reports, versions] = await Promise.all([
          api.db
            .select({ id: weeklyReports.id })
            .from(weeklyReports)
            .where(eq(weeklyReports.id, r!.id)),
          api.db
            .select({ id: weeklyReportVersions.id })
            .from(weeklyReportVersions)
            .where(eq(weeklyReportVersions.reportId, r!.id)),
        ]);
        return [reports.length, versions.length];
      };
      expect([await count(''), await count(other.orgId), await count(c.orgId)]).toEqual([
        [0, 0],
        [0, 0],
        [1, 1],
      ]);
      // WITH CHECK: ghi sai tổ chức cũng bị chặn (42501), không chỉ đọc.
      await api.db.execute(sql`select set_config('app.org_id', ${other.orgId}, false)`);
      const e = await pgErrorOf(
        api.db
          .insert(weeklyReports)
          .values({ channelId: c.channelId, orgId: c.orgId, weekStart: '2026-10-12' }),
      );
      expect(e?.code).toBe('42501');
    } finally {
      await api.close();
    }
  });

  it('notifications nhận loại `report.ready`', async () => {
    const user = await insertUser(t.db);
    const [row] = await t.db
      .insert(notifications)
      .values({ userId: user.id, type: 'report.ready', payload: {} })
      .returning({ type: notifications.type });
    expect(row?.type).toBe('report.ready');
  });

  // Đúng HÌNH DẠNG câu quét thật (cũ nhất trước, theo lô) — xem bài học M6 #1.
  it('truy vấn quét kẹt dùng được index partial `weekly_reports_stuck_idx`', async () => {
    const plan = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute<{ 'QUERY PLAN': string }>(sql`explain
        select id from ${weeklyReports}
        where ${weeklyReports.status} in ('pending', 'generating')
          and ${weeklyReports.updatedAt} < now() - interval '5 minutes'
        order by ${weeklyReports.updatedAt} limit 100`);
    });
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('weekly_reports_stuck_idx');
  });
});
