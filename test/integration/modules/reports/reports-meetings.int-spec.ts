import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingShares, meetingSummaries } from '../../../../src/infra/database/schema/index.js';
import { ReportsRepository } from '../../../../src/modules/reports/reports.repository.js';
import {
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const WEEK = '2026-10-05'; // Thứ Hai → [2026-10-04T17:00Z, 2026-10-11T17:00Z) theo giờ VN

/** Chọn meeting cho báo cáo tuần (M9 B2): biên tuần giờ VN + điều kiện D8 (completed, đang share, chưa xoá). */
describe('ReportsRepository.meetingsForWeek (Postgres thật)', () => {
  let t: TestDb;
  let repo: ReportsRepository;
  let orgId: string;
  let channelId: string;
  let otherChannelId: string;
  let ownerId: string;
  /** Tên → id, để kỳ vọng đọc được. */
  const ids: Record<string, string> = {};

  async function meeting(
    name: string,
    recordedAt: string,
    over: {
      status?: 'completed' | 'failed' | 'summarizing';
      deleted?: boolean;
      summary?: boolean;
      channels?: string[];
    } = {},
  ) {
    const m = await insertMeeting(t.db, orgId, ownerId, {
      title: name,
      recordedAt: new Date(recordedAt),
      status: over.status ?? 'completed',
      ...(over.deleted && { deletedAt: new Date() }),
    });
    ids[name] = m.id;
    for (const c of over.channels ?? [channelId]) await shareMeeting(t.db, orgId, m.id, c);
    if (over.summary !== false) {
      await t.db.insert(meetingSummaries).values({
        meetingId: m.id,
        orgId,
        content: { overview: `Tóm tắt ${name}`, keyPoints: [], decisions: [], actionItems: [] },
        model: 'fake',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
      });
    }
  }
  const names = async (week = WEEK, channel = channelId, org = orgId) =>
    (await repo.meetingsForWeek(org, channel, week)).map((m) => m.title);

  beforeAll(async () => {
    t = createTestDb(1); // 1 connection → `SET TIME ZONE` áp cho mọi câu sau
    repo = new ReportsRepository(t.db);
    const owner = await insertUser(t.db);
    ownerId = owner.id;
    orgId = (await insertOrg(t.db, ownerId)).id;
    channelId = (await insertChannel(t.db, orgId, ownerId)).id;
    otherChannelId = (await insertChannel(t.db, orgId, ownerId)).id;

    await meeting('A-truoc-biên', '2026-10-04T16:59:59.999Z'); // CN 23:59:59,999 VN tuần trước
    await meeting('B-đầu-tuần', '2026-10-04T17:00:00.000Z'); // Thứ Hai 00:00:00 VN
    await meeting('C-giữa-tuần', '2026-10-07T03:00:00Z');
    await meeting('D-cuối-tuần', '2026-10-11T16:59:59.999Z'); // CN 23:59:59,999 VN
    await meeting('E-sau-biên', '2026-10-11T17:00:00.000Z'); // Thứ Hai 00:00:00 VN tuần sau
    await meeting('F-lỗi', '2026-10-07T04:00:00Z', { status: 'failed' });
    await meeting('G-đang-xử-lý', '2026-10-07T05:00:00Z', { status: 'summarizing' });
    await meeting('H-đã-xoá', '2026-10-07T06:00:00Z', { deleted: true });
    await meeting('I-kênh-khác', '2026-10-07T07:00:00Z', { channels: [otherChannelId] });
    await meeting('J-cả-hai-kênh', '2026-10-07T08:00:00Z', {
      channels: [channelId, otherChannelId],
    });
    await meeting('K-không-tóm-tắt', '2026-10-07T09:00:00Z', { summary: false });
    await meeting('L-gỡ-share', '2026-10-07T10:00:00Z');
    await t.db.delete(meetingShares).where(eq(meetingShares.meetingId, ids['L-gỡ-share']!));
  });

  afterAll(async () => {
    await t.close();
  });

  // Đột biến: `<` thành `<=` ở biên cuối → E lọt vào; `>=` thành `>` ở biên đầu → B rơi ra.
  it('đúng tập meeting: biên [Thứ Hai 00:00, Thứ Hai kế tiếp 00:00) GIỜ VN, cũ nhất trước', async () => {
    const rows = await repo.meetingsForWeek(orgId, channelId, WEEK);
    expect(rows.map((m) => [m.title, m.recordedAt.toISOString()])).toEqual([
      ['B-đầu-tuần', '2026-10-04T17:00:00.000Z'],
      ['C-giữa-tuần', '2026-10-07T03:00:00.000Z'],
      ['J-cả-hai-kênh', '2026-10-07T08:00:00.000Z'],
      ['D-cuối-tuần', '2026-10-11T16:59:59.999Z'],
    ]);
    expect(rows[0]?.summary.overview).toBe('Tóm tắt B-đầu-tuần');
  });

  it('loại: failed / chưa xong / đã xoá / share kênh khác / đã gỡ share / không có tóm tắt', async () => {
    const got = new Set(await names());
    const excluded = [
      'F-lỗi',
      'G-đang-xử-lý',
      'H-đã-xoá',
      'I-kênh-khác',
      'L-gỡ-share',
      'K-không-tóm-tắt',
    ];
    expect(excluded.filter((n) => got.has(n))).toEqual([]);
  });

  it('meeting share vào hai kênh vào báo cáo của CẢ HAI; kênh kia chỉ có meeting của nó', async () => {
    expect(await names(WEEK, otherChannelId)).toEqual(['I-kênh-khác', 'J-cả-hai-kênh']);
  });

  it('tuần khác thì tập khác; tuần liền trước chỉ có meeting sát biên', async () => {
    expect(await names('2026-09-28')).toEqual(['A-truoc-biên']);
    expect(await names('2026-10-12')).toEqual(['E-sau-biên']);
    expect(await names('2026-10-19')).toEqual([]);
  });

  it('không lẫn tổ chức: cùng channelId nhưng org khác → rỗng', async () => {
    const stranger = await insertUser(t.db);
    const otherOrg = (await insertOrg(t.db, stranger.id)).id;
    expect(await names(WEEK, channelId, otherOrg)).toEqual([]);
  });

  // Đột biến: biên tính bằng `AT TIME ZONE 'UTC'` / `date_trunc('week', now())` → đổi theo session.
  it.each(['UTC', 'America/New_York', 'Pacific/Auckland', 'Asia/Ho_Chi_Minh'])(
    'kết quả KHÔNG đổi theo TimeZone của session DB (%s)',
    async (zone) => {
      await t.db.execute(sql.raw(`set time zone '${zone}'`));
      try {
        expect(await names()).toEqual([
          'B-đầu-tuần',
          'C-giữa-tuần',
          'J-cả-hai-kênh',
          'D-cuối-tuần',
        ]);
      } finally {
        await t.db.execute(sql`reset time zone`);
      }
    },
  );

  it('bản chép `meeting_shares.recorded_at` khớp meeting (nguồn lọc thời gian)', async () => {
    const drift = await t.db.execute<{ n: number }>(sql`
      select count(*)::int as n from meeting_shares s join meetings m on m.id = s.meeting_id
      where s.recorded_at <> m.recorded_at and m.org_id = ${orgId}`);
    expect(drift.rows[0]?.n).toBe(0);
  });
});
