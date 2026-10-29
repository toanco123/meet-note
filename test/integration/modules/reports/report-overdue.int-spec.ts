import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionItems, meetings } from '../../../../src/infra/database/schema/index.js';
import { ReportsRepository } from '../../../../src/modules/reports/reports.repository.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const WEEK = '2026-10-05'; // Thứ Hai; tuần kết thúc hết CN 2026-10-11, hạn "trước 2026-10-12" tính là quá hạn

/** Việc quá hạn của báo cáo tuần (M12 B6): lọc trạng thái / hạn / kênh / xoá, thứ tự, trần, tên người. */
describe('ReportsRepository.overdueActionItems (Postgres thật)', () => {
  // Các ca dùng chung dữ liệu dựng ở ca đầu (kênh / meeting dùng lại) nên chạy TUẦN TỰ theo thứ tự file.
  let t: TestDb;
  let repo: ReportsRepository;
  let orgId: string;
  let ownerId: string;
  let channelId: string;
  let otherChannelId: string;
  let inChannel: string; // meeting share vào channelId
  let inBoth: string; // share vào cả hai kênh
  let inOtherOnly: string; // chỉ kênh khác
  let unshared: string; // không share
  let deleted: string; // share vào channelId nhưng đã xoá mềm

  const add = async (
    meetingId: string,
    task: string,
    over: Partial<typeof actionItems.$inferInsert> = {},
  ) => {
    const [r] = await t.db
      .insert(actionItems)
      .values({ orgId, meetingId, origin: 'manual', task, ...over })
      .returning({ id: actionItems.id });
    return r!.id;
  };
  const tasks = async (limit = 50, week = WEEK, channel = channelId) =>
    (await repo.overdueActionItems(orgId, channel, week, limit)).map((i) => i.task);

  beforeAll(async () => {
    t = createTestDb();
    repo = new ReportsRepository(t.db);
    ownerId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
    channelId = (await insertChannel(t.db, orgId, ownerId)).id;
    otherChannelId = (await insertChannel(t.db, orgId, ownerId)).id;
    const mk = async (
      title: string,
      channels: string[],
      over: Partial<typeof meetings.$inferInsert> = {},
    ) => {
      const m = await insertMeeting(t.db, orgId, ownerId, { title, status: 'completed', ...over });
      for (const c of channels) await shareMeeting(t.db, orgId, m.id, c);
      return m.id;
    };
    inChannel = await mk('Họp kênh', [channelId]);
    inBoth = await mk('Họp hai kênh', [channelId, otherChannelId]);
    inOtherOnly = await mk('Họp kênh khác', [otherChannelId]);
    unshared = await mk('Họp riêng', []);
    deleted = await mk('Họp đã xoá', [channelId], { deletedAt: new Date() });
  });

  afterAll(async () => {
    await t.close();
  });

  it('chỉ việc OPEN, có hạn, hạn TRƯỚC hết tuần, của meeting đang share vào kênh và chưa xoá', async () => {
    await add(inChannel, 'ok-cuối-tuần', { dueDate: '2026-10-11' }); // CN: ngày cuối tuần → quá hạn so với tuần này
    await add(inChannel, 'ok-tuần-trước', { dueDate: '2026-09-28' }); // quá hạn từ tuần trước, vẫn mở
    await add(inBoth, 'ok-hai-kênh', { dueDate: '2026-10-07' });
    await add(inChannel, 'loại-biên-tuần-sau', { dueDate: '2026-10-12' }); // Thứ Hai tuần sau: chưa tới hạn
    await add(inChannel, 'loại-không-hạn');
    await add(inChannel, 'loại-done', {
      dueDate: '2026-10-01',
      status: 'done',
      completedAt: new Date(),
    });
    await add(inChannel, 'loại-dismissed', { dueDate: '2026-10-01', status: 'dismissed' });
    await add(inOtherOnly, 'chỉ-ở-kênh-khác', { dueDate: '2026-10-01' });
    await add(unshared, 'loại-chưa-share', { dueDate: '2026-10-01' });
    await add(deleted, 'loại-meeting-đã-xoá', { dueDate: '2026-10-01' });

    expect(await tasks()).toEqual(['ok-tuần-trước', 'ok-hai-kênh', 'ok-cuối-tuần']);
    // meeting share vào CẢ HAI kênh: việc hiện ở cả hai báo cáo; kênh kia thấy việc của nó (hạn cũ trước)
    expect(await tasks(50, WEEK, otherChannelId)).toEqual(['chỉ-ở-kênh-khác', 'ok-hai-kênh']);
  });

  it('meeting share rồi gỡ khỏi kênh thì việc không còn trong báo cáo kênh đó', async () => {
    const m = await insertMeeting(t.db, orgId, ownerId, { title: 'Họp gỡ', status: 'completed' });
    await shareMeeting(t.db, orgId, m.id, channelId);
    await add(m.id, 'việc-họp-gỡ', { dueDate: '2026-10-01' });
    expect(await tasks()).toContain('việc-họp-gỡ');
    await t.db.execute(sql`delete from meeting_shares where meeting_id = ${m.id}`);
    expect(await tasks()).not.toContain('việc-họp-gỡ');
  });

  it('tuần cũ hơn chỉ lấy việc có hạn trước tuần đó (mốc tính theo tuần, không theo hôm nay)', async () => {
    // 2026-09-28 (Thứ Hai): hết tuần là 2026-10-04 → hạn 2026-09-28 vẫn nằm trước 2026-10-05
    const week = '2026-09-28';
    const got = await tasks(50, week);
    expect(got).toContain('ok-tuần-trước'); // hạn 2026-09-28 < 2026-10-05
    expect(got).not.toContain('ok-cuối-tuần'); // hạn 2026-10-11 chưa tới hạn vào lúc đó
    expect(got).not.toContain('ok-hai-kênh');
  });

  it('hạn cũ nhất trước, cùng hạn thì theo id; limit cắt từ đầu', async () => {
    const m = await insertMeeting(t.db, orgId, ownerId, {
      title: 'Họp thứ tự',
      status: 'completed',
    });
    const other = await insertChannel(t.db, orgId, ownerId);
    await shareMeeting(t.db, orgId, m.id, other.id);
    const a = await add(m.id, 'c-2026-10-03', { dueDate: '2026-10-03' });
    const b = await add(m.id, 'a-2026-10-01-1', { dueDate: '2026-10-01' });
    const c = await add(m.id, 'b-2026-10-01-2', { dueDate: '2026-10-01' });
    const rows = await repo.overdueActionItems(orgId, other.id, WEEK, 50);
    // b, c cùng hạn: theo id (uuidv7 tăng theo thời điểm tạo → b trước c)
    expect(rows.map((r) => r.id)).toEqual([b, c, a]);
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-10-01', '2026-10-01', '2026-10-03']);
    expect((await repo.overdueActionItems(orgId, other.id, WEEK, 2)).map((r) => r.id)).toEqual([
      b,
      c,
    ]);
  });

  it('người phụ trách: tên thành viên được giao; chưa map được thì tên model nghe được; chưa ai thì null', async () => {
    const member = await insertUser(t.db, { displayName: 'Nguyễn Văn Bình' });
    await addMember(t.db, orgId, member.id);
    const ch = await insertChannel(t.db, orgId, ownerId);
    const m = await insertMeeting(t.db, orgId, ownerId, { status: 'completed' });
    await shareMeeting(t.db, orgId, m.id, ch.id);
    await add(m.id, 'giao-thành-viên', {
      dueDate: '2026-10-01',
      assigneeId: member.id,
      ownerName: 'anh Bình',
    });
    await add(m.id, 'chỉ-có-tên-model', { dueDate: '2026-10-02', ownerName: 'chị Lan' });
    await add(m.id, 'chưa-ai', { dueDate: '2026-10-03' });
    const rows = await repo.overdueActionItems(orgId, ch.id, WEEK, 10);
    expect(rows.map((r) => [r.task, r.assignee])).toEqual([
      ['giao-thành-viên', 'Nguyễn Văn Bình'], // tên thật, KHÔNG phải 'anh Bình'
      ['chỉ-có-tên-model', 'chị Lan'],
      ['chưa-ai', null],
    ]);
    expect(rows[0]).toMatchObject({
      meetingId: m.id,
      meetingTitle: 'Họp giao ban',
      dueDate: '2026-10-01',
    });
  });

  it('không lẫn org: org khác có việc quá hạn trên cùng tuần thì không lọt vào', async () => {
    const other = await insertUser(t.db);
    const otherOrg = (await insertOrg(t.db, other.id)).id;
    const oc = await insertChannel(t.db, otherOrg, other.id);
    const m = await insertMeeting(t.db, otherOrg, other.id, { status: 'completed' });
    await shareMeeting(t.db, otherOrg, m.id, oc.id);
    await t.db.insert(actionItems).values({
      orgId: otherOrg,
      meetingId: m.id,
      origin: 'manual',
      task: 'org-khác',
      dueDate: '2026-10-01',
    });
    expect(await tasks()).not.toContain('org-khác');
    // và hỏi nhầm org với kênh của org kia cũng không ra gì
    expect(await repo.overdueActionItems(orgId, oc.id, WEEK, 10)).toEqual([]);
    expect((await repo.overdueActionItems(otherOrg, oc.id, WEEK, 10)).map((r) => r.task)).toEqual([
      'org-khác',
    ]);
  });
});
