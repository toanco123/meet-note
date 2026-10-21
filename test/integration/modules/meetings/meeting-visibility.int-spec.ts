import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channels, meetings } from '../../../../src/infra/database/schema/index.js';
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

/**
 * TOÀN BỘ ma trận quyền xem meeting (04 §3, M6b Q1 + Q2) trên Postgres thật, qua đúng biểu thức
 * mà mọi query dùng. Mỗi người xem → TẬP meeting thấy được (so cả tập: thấy thừa cũng đỏ).
 */
describe('meetingVisibleTo — ma trận quyền xem (Postgres thật)', () => {
  let t: TestDb;
  let orgId: string;
  let otherOrgId: string;
  const viewers: Record<string, MeetingViewer> = {};
  /** id meeting → tên đọc được, để diff khi đỏ dễ hiểu. */
  const names = new Map<string, string>();

  beforeAll(async () => {
    t = createTestDb();
    const db = t.db;
    const orgOwner = await insertUser(db);
    orgId = (await insertOrg(db, orgOwner.id)).id;
    const user = async (role: 'admin' | 'member') => {
      const u = await insertUser(db);
      await addMember(db, orgId, u.id, role);
      return u.id;
    };
    const [author, host, chMember, chGuest, outsider, orgAdmin] = [
      await user('member'),
      await user('member'),
      await user('member'),
      await user('member'),
      await user('member'),
      await user('admin'),
    ];
    const stranger = await insertUser(db);
    otherOrgId = (await insertOrg(db, stranger.id)).id;

    // Kênh do `host` làm chủ — Owner / Admin org KHÔNG ở trong kênh nào.
    const priv = (await insertChannel(db, orgId, host, { visibility: 'private' })).id;
    const pub = (await insertChannel(db, orgId, host, { visibility: 'public' })).id;
    const archivedPub = (await insertChannel(db, orgId, host, { visibility: 'public' })).id;
    const deletedPub = (await insertChannel(db, orgId, host, { visibility: 'public' })).id;
    const deletedPriv = (await insertChannel(db, orgId, host, { visibility: 'private' })).id;
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archivedPub));
    await db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(inArray(channels.id, [deletedPub, deletedPriv]));
    await addChannelMember(db, { id: priv }, orgId, chMember, 'member');
    await addChannelMember(db, { id: priv }, orgId, chGuest, 'guest');
    await addChannelMember(db, { id: deletedPriv }, orgId, chMember, 'member');

    const meeting = async (name: string, ownerId: string | null, shareTo: string[]) => {
      const { id } = await insertMeeting(db, orgId, ownerId);
      for (const channelId of shareTo) await shareMeeting(db, orgId, id, channelId);
      names.set(id, name);
      return id;
    };
    await meeting('riêng tư', author, [priv]);
    await meeting('công khai', author, [pub]);
    await meeting('công khai lưu trữ', author, [archivedPub]);
    await meeting('chỉ ở kênh đã xoá', author, [deletedPub, deletedPriv]);
    const deleted = await meeting('meeting đã xoá', author, [pub]);
    await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, deleted));
    await meeting('chưa share', author, []);
    await meeting('không chủ, chưa share', null, []);
    await meeting('không chủ, ở kênh riêng tư', null, [priv]);

    Object.assign(viewers, {
      author: { userId: author, orgRole: 'member' },
      chMember: { userId: chMember, orgRole: 'member' },
      chGuest: { userId: chGuest, orgRole: 'member' },
      outsider: { userId: outsider, orgRole: 'member' },
      orgAdmin: { userId: orgAdmin, orgRole: 'admin' },
      orgOwner: { userId: orgOwner.id, orgRole: 'owner' },
    } satisfies Record<string, MeetingViewer>);
    viewers.stranger = { userId: stranger.id, orgRole: 'owner' };
  });

  afterAll(async () => {
    await t.close();
  });

  async function visibleNames(viewer: MeetingViewer, org = orgId): Promise<string[]> {
    const rows = await t.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.orgId, org), meetingVisibleTo(viewer)));
    return rows.map((r) => names.get(r.id) ?? r.id).sort();
  }

  const pubAll = ['công khai', 'công khai lưu trữ'];

  it.each([
    // Chủ thấy mọi meeting CHƯA XOÁ của mình, kể cả chỉ nằm ở kênh đã xoá / chưa share.
    ['author', ['chỉ ở kênh đã xoá', 'chưa share', 'riêng tư', ...pubAll]],
    // Thành viên kênh riêng tư (mọi vai trò); kênh riêng tư ĐÃ XOÁ thì không còn tác dụng.
    ['chMember', ['không chủ, ở kênh riêng tư', 'riêng tư', ...pubAll]],
    ['chGuest', ['không chủ, ở kênh riêng tư', 'riêng tư', ...pubAll]],
    // Thành viên org ngoài kênh: chỉ kênh công khai — kể cả kênh LƯU TRỮ (Q1).
    ['outsider', pubAll],
    // OrgAdm: công khai + meeting KHÔNG CHỦ (Q2); không đọc nội dung kênh riêng tư (D2).
    ['orgAdmin', ['không chủ, chưa share', 'không chủ, ở kênh riêng tư', ...pubAll]],
    ['orgOwner', ['không chủ, chưa share', 'không chủ, ở kênh riêng tư', ...pubAll]],
  ])('%s', async (viewer, expected) => {
    const v = viewers[viewer];
    if (!v) throw new Error(`thiếu người xem ${viewer}`);
    expect(await visibleNames(v)).toEqual([...expected].sort());
  });

  /**
   * TIỀN ĐIỀU KIỆN, không phải lỗi: biểu thức KHÔNG tự kiểm người xem có thuộc org — `OrgMemberGuard`
   * chặn người ngoài (404) và cấp `orgRole` thật. Bỏ qua guard thì người org khác thấy meeting kênh
   * công khai. Test ghi lại điều đó để không ai dùng biểu thức này ở chỗ không có guard mà tưởng an toàn.
   */
  it('người org khác: trong org của mình không thấy gì; nếu BỎ QUA guard thì thấy kênh công khai', async () => {
    const v = viewers.stranger;
    if (!v) throw new Error('thiếu stranger');
    expect([await visibleNames(v, otherOrgId), await visibleNames(v)]).toEqual([
      [],
      ['không chủ, chưa share', 'không chủ, ở kênh riêng tư', ...pubAll].sort(),
    ]);
  });
});
