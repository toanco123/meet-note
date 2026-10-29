import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetings } from '../../../../src/infra/database/schema/index.js';
import { DashboardRepository } from '../../../../src/modules/dashboard/dashboard.repository.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const DAY = '2026-10-05'; // theo giờ VN: [2026-10-04T17:00Z, 2026-10-05T17:00Z)

/** Câu tính lại MỘT ngày của rollup (M17 B1): đếm đúng, biên ngày VN, idempotent, theo kịp nguồn đổi. */
describe('DashboardRepository.rollupDay (Postgres thật)', () => {
  let t: TestDb;
  let repo: DashboardRepository;
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    t = createTestDb(1); // 1 connection → `SET TIME ZONE` áp cho mọi câu sau
    repo = new DashboardRepository(t.db);
    ownerId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  const mk = (
    recordedAt: string,
    over: Partial<typeof meetings.$inferInsert> = {},
    org = orgId,
    owner = ownerId,
  ) =>
    insertMeeting(t.db, org, owner, {
      recordedAt: new Date(recordedAt),
      status: 'completed',
      durationMs: 60_000,
      ...over,
    });
  const stats = async (day = DAY, org = orgId) => {
    await repo.rollupDay(org, day);
    const [r] = await repo.readRange(org, day, day);
    return r!;
  };

  // Mỗi ca dùng một ngày RIÊNG (không đụng nhau) trừ khi ca cần tính lại cùng ngày.
  it('đếm theo trạng thái và cộng thời lượng; đang xử lý chỉ nằm trong total', async () => {
    const day = '2026-03-02';
    const at = '2026-03-02T03:00:00Z';
    await mk(at, { durationMs: 600_000 }); // completed
    await mk(at, { durationMs: 300_000 }); // completed
    await mk(at, { status: 'failed', durationMs: 120_000, failureCode: 'TRANSCRIBE_FAILED' });
    await mk(at, { status: 'transcribing', durationMs: 50_000 });
    await mk(at, { status: 'queued', durationMs: null }); // chưa biết thời lượng
    expect(await stats(day)).toMatchObject({
      day,
      meetingsTotal: 5,
      meetingsCompleted: 2,
      meetingsFailed: 1,
      recordedMs: 600_000 + 300_000 + 120_000 + 50_000,
      transcribedMs: 900_000, // chỉ meeting completed
    });
  });

  // Đột biến: cắt ngày theo UTC (`recorded_at::date`) → 2 trong 4 ca dưới lọt sai ngày.
  it('biên ngày theo GIỜ VN: 16:59:59.999Z còn trong ngày, 17:00:00Z đã sang ngày sau', async () => {
    const day = '2026-04-10';
    await mk('2026-04-09T16:59:59.999Z'); // CN 23:59:59,999 VN của ngày 09 → ngoài
    await mk('2026-04-09T17:00:00.000Z'); // 00:00:00 VN ngày 10 → trong
    await mk('2026-04-10T16:59:59.999Z'); // 23:59:59,999 VN ngày 10 → trong
    await mk('2026-04-10T17:00:00.000Z'); // 00:00:00 VN ngày 11 → ngoài
    expect((await stats(day)).meetingsTotal).toBe(2);
    expect((await stats('2026-04-09')).meetingsTotal).toBe(1);
    expect((await stats('2026-04-11')).meetingsTotal).toBe(1);
  });

  it('qua năm theo giờ VN: 2026-12-31T18:30Z là ngày 2027-01-01', async () => {
    await mk('2026-12-31T18:30:00Z');
    expect((await stats('2026-12-31')).meetingsTotal).toBe(0);
    expect((await stats('2027-01-01')).meetingsTotal).toBe(1);
  });

  // Đột biến: bỏ `deleted_at is null`.
  it('meeting đã xoá mềm không tính', async () => {
    const day = '2026-05-04';
    await mk('2026-05-04T03:00:00Z');
    await mk('2026-05-04T04:00:00Z', { deletedAt: new Date() });
    expect((await stats(day)).meetingsTotal).toBe(1);
  });

  it('chạy hai lần liên tiếp cho cùng kết quả (không cộng dồn)', async () => {
    const day = '2026-06-08';
    await mk('2026-06-08T03:00:00Z', { durationMs: 1000 });
    const first = await stats(day);
    const second = await stats(day);
    expect({ ...second, computedAt: undefined }).toEqual({ ...first, computedAt: undefined });
    expect(second.meetingsTotal).toBe(1);
    expect(second.recordedMs).toBe(1000);
    expect(second.computedAt.getTime()).toBeGreaterThanOrEqual(first.computedAt.getTime());
  });

  // Đột biến: `DO NOTHING` thay `DO UPDATE` → số cũ nằm lại.
  it('nguồn đổi rồi tính lại → số đổi theo: thêm, đổi trạng thái, xoá', async () => {
    const day = '2026-07-06';
    const a = await mk('2026-07-06T03:00:00Z', { status: 'summarizing', durationMs: 1000 });
    expect(await stats(day)).toMatchObject({ meetingsTotal: 1, meetingsCompleted: 0 });

    await t.db.update(meetings).set({ status: 'completed' }).where(eq(meetings.id, a.id));
    expect(await stats(day)).toMatchObject({ meetingsCompleted: 1, transcribedMs: 1000 });

    const b = await mk('2026-07-06T05:00:00Z', { status: 'failed', durationMs: 500 });
    expect(await stats(day)).toMatchObject({
      meetingsTotal: 2,
      meetingsFailed: 1,
      recordedMs: 1500,
    });

    await t.db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, b.id));
    expect(await stats(day)).toMatchObject({
      meetingsTotal: 1,
      meetingsFailed: 0,
      recordedMs: 1000,
    });
  });

  it('ngày hết meeting (xoá hết / chuyển sang ngày khác) → dòng về 0, KHÔNG giữ số cũ', async () => {
    const day = '2026-08-03';
    const m = await mk('2026-08-03T03:00:00Z', { durationMs: 7000 });
    expect((await stats(day)).meetingsTotal).toBe(1);
    // sửa recorded_at sang ngày khác
    await t.db
      .update(meetings)
      .set({ recordedAt: new Date('2026-08-05T03:00:00Z') })
      .where(eq(meetings.id, m.id));
    expect(await stats(day)).toMatchObject({
      meetingsTotal: 0,
      meetingsCompleted: 0,
      meetingsFailed: 0,
      recordedMs: 0,
      transcribedMs: 0,
    });
    // ngày mới chỉ đúng sau khi chính nó được tính lại — ngày cũ không tự biết (lý do cần job sự kiện, B2)
    expect((await stats('2026-08-05')).meetingsTotal).toBe(1);
  });

  it('không lẫn tổ chức: cùng ngày, org khác có meeting thì không vào số của org này', async () => {
    const day = '2026-09-07';
    const otherOwner = (await insertUser(t.db)).id;
    const otherOrg = (await insertOrg(t.db, otherOwner)).id;
    await mk('2026-09-07T03:00:00Z');
    await mk('2026-09-07T03:00:00Z', {}, otherOrg, otherOwner);
    await mk('2026-09-07T04:00:00Z', {}, otherOrg, otherOwner);
    expect((await stats(day)).meetingsTotal).toBe(1);
    expect((await stats(day, otherOrg)).meetingsTotal).toBe(2);
  });

  it('readRange: bao gồm hai đầu, ngày tăng dần, chỉ ngày đã tính, đúng org', async () => {
    const otherOwner = (await insertUser(t.db)).id;
    const org = (await insertOrg(t.db, otherOwner)).id;
    for (const d of ['2026-11-03', '2026-11-01', '2026-11-02', '2026-11-05'])
      await repo.rollupDay(org, d);
    const days = async (from: string, to: string) =>
      (await repo.readRange(org, from, to)).map((r) => r.day);
    expect(await days('2026-11-01', '2026-11-05')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-05', // 11-04 chưa tính → không có dòng
    ]);
    expect(await days('2026-11-02', '2026-11-03')).toEqual(['2026-11-02', '2026-11-03']);
    expect(await days('2026-11-06', '2026-11-30')).toEqual([]);
    expect(await repo.readRange(orgId, '2026-11-01', '2026-11-05')).toEqual([]); // org khác
  });
});
