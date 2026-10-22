import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels, meetings } from '../../../../src/infra/database/schema/index.js';
import type { MeetingStatus } from '../../../../src/infra/database/schema/index.js';
import { meetingVisibleTo } from '../../../../src/modules/meetings/meeting-visibility.js';
import type {
  ListVisibleMeetingsParams,
  MeetingViewer,
} from '../../../../src/modules/meetings/meetings.types.js';
import { MeetingsRepository } from '../../../../src/modules/meetings/repositories/meetings.repository.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/**
 * TEST ĐỐI CHIẾU (oracle) cho danh sách meeting (M11 B5). `listVisible` không còn ghép
 * `meetingVisibleTo` (điều kiện xem DUY NHẤT, 04 §3) mà sinh ứng viên từ các luồng có trần — nên ở
 * đây: với mọi người xem × bộ lọc, duyệt HẾT các trang (limit nhỏ) và so với "sự thật" do chính
 * `meetingVisibleTo` tính. Dữ liệu chọn để CẢ HAI hình dạng luồng "qua kênh" đều chạy (k² < K: theo
 * từng kênh; ngược lại: một lượt theo thời gian).
 */
describe('Danh sách meeting = điều kiện xem dùng chung (oracle, Postgres thật)', () => {
  let t: TestDb;
  let repo: MeetingsRepository;
  let orgId: string;
  const viewers: Array<{ name: string; viewer: MeetingViewer; channelIds: string[] }> = [];

  /**
   * Số giả ngẫu nhiên cố định (LCG Park–Miller) — dữ liệu như nhau mỗi lần chạy. BẪY: LCG kiểu
   * `seed * 1103515245` vượt 2^53 → `number` mất bit thấp → `% 4`, `% 8` luôn ra 0 (lần đầu: mọi
   * meeting bị "xoá", không share nào). `48271 * seed` < 2^47 nên tính chính xác.
   */
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % n;
  };

  beforeAll(async () => {
    t = createTestDb();
    repo = new MeetingsRepository(t.db);
    const owner = await insertUser(t.db);
    orgId = (await insertOrg(t.db, owner.id)).id;
    const [admin, a, b, guest, newbie, other] = await Promise.all(
      Array.from({ length: 6 }, () => insertUser(t.db)),
    );
    await addMember(t.db, orgId, admin!.id, 'admin');
    for (const u of [a, b, guest, newbie, other]) await addMember(t.db, orgId, u!.id);

    // 12 kênh: 2 công khai (1 đã xoá), 10 riêng tư (1 đã xoá, 1 lưu trữ) → K = 10 kênh chưa xoá.
    const chans: Array<{ id: string }> = [];
    for (let i = 0; i < 12; i++) {
      chans.push(
        await insertChannel(t.db, orgId, owner.id, { visibility: i < 2 ? 'public' : 'private' }),
      );
    }
    const [publicDeleted, privateDeleted, privateArchived] = [chans[1]!, chans[2]!, chans[3]!];
    await t.db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(sql`${channels.id} in (${publicDeleted.id}, ${privateDeleted.id})`);
    await t.db
      .update(channels)
      .set({ archivedAt: new Date() })
      .where(eq(channels.id, privateArchived.id));
    // a: 1 kênh riêng tư (k = 2 với kênh công khai → 4 < 10: theo từng kênh);
    // b: 7 kênh riêng tư (k = 8 → 64 ≥ 10: một lượt); guest: khách ở kênh lưu trữ + kênh đã xoá.
    await addChannelMember(t.db, chans[4]!, orgId, a!.id, 'member');
    for (const c of chans.slice(3, 10)) await addChannelMember(t.db, c, orgId, b!.id, 'member');
    await addChannelMember(t.db, privateArchived, orgId, guest!.id, 'guest');
    await addChannelMember(t.db, privateDeleted, orgId, guest!.id, 'guest');

    // 60 meeting: chủ là a / b / other / KHÔNG CHỦ; ~1/8 đã xoá; recorded_at từ 6 mốc → nhiều trùng.
    const owners = [a!.id, b!.id, other!.id, null];
    const statuses: MeetingStatus[] = ['completed', 'completed', 'failed', 'queued'];
    for (let i = 0; i < 60; i++) {
      const meeting = await insertMeeting(t.db, orgId, owners[rand(4)]!, {
        recordedAt: new Date(Date.UTC(2026, 0, 1 + rand(6))),
        status: statuses[rand(4)]!,
        ...(rand(8) === 0 && { deletedAt: new Date() }),
      });
      const shareCount = rand(4); // 0..3 kênh, kể cả kênh đã xoá
      const picked = new Set(Array.from({ length: shareCount }, () => chans[rand(12)]!.id));
      for (const channelId of picked) await shareMeeting(t.db, orgId, meeting.id, channelId);
    }

    const visibleTo = (ids: Array<{ id: string }>) => ids.map((c) => c.id);
    viewers.push(
      { name: 'Owner org', viewer: { userId: owner.id, orgRole: 'owner' }, channelIds: [] },
      { name: 'Admin org', viewer: { userId: admin!.id, orgRole: 'admin' }, channelIds: [] },
      {
        name: 'a (theo từng kênh)',
        viewer: { userId: a!.id, orgRole: 'member' },
        channelIds: visibleTo([chans[0]!, chans[4]!]),
      },
      {
        name: 'b (một lượt)',
        viewer: { userId: b!.id, orgRole: 'member' },
        channelIds: visibleTo([chans[0]!, ...chans.slice(3, 10)]),
      },
      {
        name: 'khách',
        viewer: { userId: guest!.id, orgRole: 'member' },
        channelIds: visibleTo([chans[0]!, privateArchived]),
      },
      { name: 'mới vào', viewer: { userId: newbie!.id, orgRole: 'member' }, channelIds: [] },
    );
  });

  afterAll(async () => {
    await t.close();
  });

  /** "Sự thật": đúng câu danh sách TRƯỚC M11 B5 — `meetingVisibleTo` + bộ lọc. */
  async function oracle(p: Omit<ListVisibleMeetingsParams, 'limit' | 'after'>) {
    const rows = await t.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.orgId, p.orgId),
          meetingVisibleTo(p.viewer),
          p.status ? eq(meetings.status, p.status) : undefined,
          p.from ? gte(meetings.recordedAt, p.from) : undefined,
          p.to ? lt(meetings.recordedAt, p.to) : undefined,
          p.channelId
            ? sql`exists (select 1 from meeting_shares s where s.meeting_id = ${meetings.id} and s.channel_id = ${p.channelId})`
            : undefined,
        ),
      )
      .orderBy(desc(meetings.recordedAt), desc(meetings.id));
    return rows.map((r) => r.id);
  }

  /** Duyệt HẾT các trang như client (limit 4, cursor = dòng cuối) — bắt cả lỗi "dừng sớm". */
  async function allPages(p: Omit<ListVisibleMeetingsParams, 'limit' | 'after'>) {
    const ids: string[] = [];
    let after: ListVisibleMeetingsParams['after'];
    for (;;) {
      const rows = await repo.listVisible({ ...p, limit: 4, after });
      ids.push(...rows.slice(0, 4).map((r) => r.id));
      if (rows.length <= 4) return ids;
      const last = rows[3]!;
      after = { recordedAt: last.recordedAtKey, id: last.id };
    }
  }

  it('mọi người xem × mọi bộ lọc × duyệt hết trang → đúng tập và đúng thứ tự của `meetingVisibleTo`', async () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (const { name, viewer, channelIds } of viewers) {
      const filters: Array<[string, Partial<ListVisibleMeetingsParams>]> = [
        ['không lọc', {}],
        ['status=failed', { status: 'failed' }],
        ['from/to', { from: new Date(Date.UTC(2026, 0, 2)), to: new Date(Date.UTC(2026, 0, 5)) }],
        ...channelIds.map((id): [string, Partial<ListVisibleMeetingsParams>] => [
          `kênh ${id.slice(-4)}`,
          { channelId: id },
        ]),
      ];
      for (const [label, filter] of filters) {
        const p = { orgId, viewer, ...filter };
        const [expected, actual] = [await oracle(p), await allPages(p)];
        compared += expected.length;
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(`${name} / ${label}: mong ${expected.length}, nhận ${actual.length}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(100); // dữ liệu đủ dày để so sánh có nghĩa
  });
});
