import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ActionItemStatus,
  actionItems,
  channels,
  meetings,
} from '../../../../src/infra/database/schema/index.js';
import { ActionItemsRepository } from '../../../../src/modules/action-items/action-items.repository.js';
import type { ListVisibleActionItemsParams } from '../../../../src/modules/action-items/action-items.types.js';
import { meetingVisibleTo } from '../../../../src/modules/meetings/meeting-visibility.js';
import type { MeetingViewer } from '../../../../src/modules/meetings/meetings.types.js';
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

interface Truth {
  id: string;
  meetingId: string;
  assigneeId: string | null;
  status: ActionItemStatus;
  dueDate: string | null;
}

/**
 * TEST ĐỐI CHIẾU (oracle) cho "việc xuyên meeting" (M12 B4): với mọi người xem × bộ lọc, duyệt HẾT các
 * trang (limit nhỏ) và so với "sự thật" tính bằng JS từ tập meeting do CHÍNH `meetingVisibleTo` (định
 * nghĩa quyền xem, 04 §3) trả về. Dữ liệu có nhiều việc CÙNG hạn và nhiều việc KHÔNG hạn để cursor
 * keyset phải đi qua mọi ranh giới: giữa hai hạn, trong một nhóm cùng hạn, sang nhóm không hạn.
 */
describe('Việc xuyên meeting = điều kiện xem dùng chung (oracle, Postgres thật)', () => {
  let t: TestDb;
  let repo: ActionItemsRepository;
  let orgId: string;
  let pubId: string;
  let privId: string;
  let privDeletedId: string;
  const viewers: Array<{ name: string; viewer: MeetingViewer }> = [];
  const truth: Truth[] = [];

  /** Park–Miller (xem bài học ở `meeting-list-oracle`): `48271 * seed` < 2^47 nên tính chính xác. */
  let seed = 13;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed % n;
  };
  const DUES = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', null, null];
  const STATUSES: ActionItemStatus[] = ['open', 'open', 'open', 'done', 'dismissed'];

  beforeAll(async () => {
    t = createTestDb();
    repo = new ActionItemsRepository(t.db);
    const owner = await insertUser(t.db);
    orgId = (await insertOrg(t.db, owner.id)).id;
    const otherOrgId = (await insertOrg(t.db, owner.id)).id;
    const [admin, author, member, guest, newbie] = await Promise.all(
      Array.from({ length: 5 }, () => insertUser(t.db)),
    );
    await addMember(t.db, orgId, admin!.id, 'admin');
    for (const u of [author, member, guest, newbie]) await addMember(t.db, orgId, u!.id);

    const pub = await insertChannel(t.db, orgId, owner.id, { visibility: 'public' });
    const priv = await insertChannel(t.db, orgId, owner.id, { visibility: 'private' });
    const privDeleted = await insertChannel(t.db, orgId, owner.id, { visibility: 'private' });
    pubId = pub.id;
    privId = priv.id;
    privDeletedId = privDeleted.id;
    await t.db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, privDeleted.id));
    await addChannelMember(t.db, priv, orgId, member!.id, 'member');
    await addChannelMember(t.db, priv, orgId, guest!.id, 'guest');
    await addChannelMember(t.db, privDeleted, orgId, newbie!.id, 'member');

    const assignees = [null, author!.id, member!.id, newbie!.id];
    for (let i = 0; i < 40; i++) {
      const ownerId = rand(3) === 0 ? null : author!.id;
      const dead = rand(6) === 0;
      const m = await insertMeeting(t.db, orgId, ownerId, {
        ...(dead && { deletedAt: new Date() }),
      });
      for (const c of [pub, priv, privDeleted]) {
        if (rand(3) === 0) await shareMeeting(t.db, orgId, m.id, c.id);
      }
      const n = rand(5);
      for (let k = 0; k < n; k++) {
        const status = STATUSES[rand(STATUSES.length)]!;
        const dueDate = DUES[rand(DUES.length)]!;
        const assigneeId = assignees[rand(assignees.length)]!;
        const [row] = await t.db
          .insert(actionItems)
          .values({
            orgId,
            meetingId: m.id,
            origin: 'manual',
            task: `việc ${i}.${k}`,
            status,
            dueDate,
            assigneeId,
            ...(status === 'done' && { completedAt: new Date() }),
          })
          .returning({ id: actionItems.id });
        truth.push({ id: row!.id, meetingId: m.id, assigneeId, status, dueDate });
      }
    }
    // Việc của org KHÁC không bao giờ được lọt (cùng người gọi không thuộc org đó).
    const foreign = await insertMeeting(t.db, otherOrgId, owner.id);
    await t.db.insert(actionItems).values({
      orgId: otherOrgId,
      meetingId: foreign.id,
      origin: 'manual',
      task: 'việc org khác',
      status: 'open',
    });

    const vs: Array<[string, string, 'owner' | 'admin' | 'member']> = [
      ['org owner', owner.id, 'owner'],
      ['org admin', admin!.id, 'admin'],
      ['author (chủ meeting)', author!.id, 'member'],
      ['member trong kênh riêng', member!.id, 'member'],
      ['guest trong kênh riêng', guest!.id, 'member'],
      ['newbie (chỉ trong kênh riêng đã xoá)', newbie!.id, 'member'],
    ];
    for (const [name, userId, orgRole] of vs) viewers.push({ name, viewer: { userId, orgRole } });
  });

  afterAll(async () => {
    await t.close();
  });

  /** Tập meeting người xem thấy, do chính điều kiện xem (định nghĩa) tính. */
  async function visibleMeetings(viewer: MeetingViewer): Promise<Set<string>> {
    const rows = await t.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.orgId, orgId), meetingVisibleTo(viewer)));
    return new Set(rows.map((r) => r.id));
  }
  const sharedIn = async (channelId: string): Promise<Set<string>> => {
    const rows = await t.db.execute<{ meeting_id: string }>(
      sql`select meeting_id from meeting_shares where channel_id = ${channelId}`,
    );
    return new Set(rows.rows.map((r) => r.meeting_id));
  };
  const compare = (a: Truth, b: Truth) => {
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  async function walk(
    base: Omit<ListVisibleActionItemsParams, 'after' | 'limit'>,
    limit: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let after: ListVisibleActionItemsParams['after'];
    for (let guard = 0; guard < 200; guard++) {
      const rows = await repo.listVisible({ ...base, after, limit });
      const page = rows.slice(0, limit);
      ids.push(...page.map((r) => r.item.id));
      if (rows.length <= limit) return ids;
      const last = page.at(-1)!.item;
      after = { dueDate: last.dueDate, id: last.id };
    }
    throw new Error('Phân trang không dừng — cursor không tiến');
  }

  it('mọi người xem × mọi bộ lọc × duyệt hết trang → đúng tập và đúng thứ tự', async () => {
    const pubShared = await sharedIn(pubId);
    const privShared = await sharedIn(privId);
    const privDeletedShared = await sharedIn(privDeletedId);
    let combos = 0;
    let nonEmpty = 0;
    for (const { name, viewer } of viewers) {
      const visible = await visibleMeetings(viewer);
      for (const assignedToViewer of [false, true]) {
        for (const status of ['open', 'done', 'dismissed'] as const) {
          for (const overdueBefore of [undefined, '2026-01-03']) {
            for (const channelId of [undefined, pubId, privId, privDeletedId]) {
              const inChannel =
                channelId === pubId
                  ? pubShared
                  : channelId === privId
                    ? privShared
                    : channelId === privDeletedId
                      ? privDeletedShared
                      : undefined;
              const expected = truth
                .filter(
                  (x) =>
                    visible.has(x.meetingId) &&
                    (!assignedToViewer || x.assigneeId === viewer.userId) &&
                    x.status === status &&
                    // Quá hạn = ĐANG MỞ và hạn trước mốc; việc done / dismissed không bao giờ quá hạn.
                    (overdueBefore === undefined ||
                      (x.status === 'open' && x.dueDate !== null && x.dueDate < overdueBefore)) &&
                    (inChannel === undefined || inChannel.has(x.meetingId)),
                )
                .sort(compare)
                .map((x) => x.id);
              const label = `${name} assigned=${assignedToViewer} ${status} overdue=${overdueBefore} ch=${channelId}`;
              for (const limit of [1, 3, 100]) {
                const got = await walk(
                  { orgId, viewer, assignedToViewer, status, overdueBefore, channelId },
                  limit,
                );
                expect(got, `${label} limit=${limit}`).toEqual(expected);
              }
              combos++;
              if (expected.length > 0) nonEmpty++;
            }
          }
        }
      }
    }
    // Chống oracle "rỗng == rỗng": phần lớn tổ hợp phải có dữ liệu để so.
    expect(combos).toBe(6 * 2 * 3 * 2 * 4);
    expect(nonEmpty).toBeGreaterThan(combos / 4);
  });

  it('bất biến cứng, không phụ thuộc định nghĩa: không bao giờ có việc org khác / meeting đã xoá / meeting người xem không thấy', async () => {
    for (const { viewer } of viewers) {
      const got = await walk({ orgId, viewer, assignedToViewer: false, status: 'open' }, 7);
      const rows = await t.db
        .select({ task: actionItems.task, deletedAt: meetings.deletedAt })
        .from(actionItems)
        .innerJoin(meetings, eq(meetings.id, actionItems.meetingId))
        .where(
          sql`${actionItems.id} in (${sql.join(
            got.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      expect(rows.some((r) => r.task === 'việc org khác')).toBe(false);
      expect(rows.some((r) => r.deletedAt !== null)).toBe(false);
    }
    // Chủ meeting thấy đủ việc open của meeting mình (chưa xoá); newbie KHÔNG thấy gì của author.
    const author = viewers.find((v) => v.name.startsWith('author'))!.viewer;
    const newbie = viewers.find((v) => v.name.startsWith('newbie'))!.viewer;
    const authorIds = await walk(
      { orgId, viewer: author, assignedToViewer: false, status: 'open' },
      100,
    );
    expect(authorIds.length).toBeGreaterThan(0);
    const newbieIds = await walk(
      { orgId, viewer: newbie, assignedToViewer: false, status: 'open' },
      100,
    );
    const newbieOwn = new Set(newbieIds);
    // Mọi việc newbie thấy phải thuộc meeting công khai hoặc của mình — không có meeting riêng tư của author.
    const pubShared = await sharedIn(pubId);
    const open = truth.filter((x) => newbieOwn.has(x.id));
    expect(open.every((x) => pubShared.has(x.meetingId))).toBe(true);
  });

  it('cursor ở ranh giới nhóm: sau việc có hạn cuối cùng vẫn sang việc KHÔNG hạn; việc không hạn không lặp', async () => {
    const owner = viewers[0]!.viewer;
    const all = await walk({ orgId, viewer: owner, assignedToViewer: false, status: 'open' }, 1);
    const withDue = all.filter((id) => truth.find((x) => x.id === id)!.dueDate !== null);
    const noDue = all.filter((id) => truth.find((x) => x.id === id)!.dueDate === null);
    expect(withDue.length).toBeGreaterThan(0);
    expect(noDue.length).toBeGreaterThan(0);
    expect(all).toEqual([...withDue, ...noDue]); // việc không hạn dồn cuối
    expect(new Set(all).size).toBe(all.length); // không lặp
  });
});
