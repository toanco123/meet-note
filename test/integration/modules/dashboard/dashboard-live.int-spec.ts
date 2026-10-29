import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionItems,
  channels,
  meetingShares,
  meetings,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { DashboardLiveRepository } from '../../../../src/modules/dashboard/repositories/dashboard-live.repository.js';
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

// Khoảng [2026-05-10, 2026-05-12] giờ VN = [2026-05-09T17:00:00Z, 2026-05-12T17:00:00Z).
const FROM = '2026-05-10';
const TO = '2026-05-12';
const IN_FIRST = '2026-05-09T17:00:00.000Z'; // 00:00:00 VN ngày 10 → trong
const BEFORE = '2026-05-09T16:59:59.999Z'; // 23:59:59,999 VN ngày 09 → ngoài
const IN_LAST = '2026-05-12T16:59:59.999Z'; // 23:59:59,999 VN ngày 12 → trong
const AFTER = '2026-05-12T17:00:00.000Z'; // 00:00:00 VN ngày 13 → ngoài
const MID = '2026-05-11T05:00:00.000Z';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Số liệu tính trực tiếp của dashboard (M17 B3): mỗi số có bảng kỳ vọng dựng tay, org khác không lẫn. */
describe('DashboardLiveRepository (Postgres thật)', () => {
  let t: TestDb;
  let repo: DashboardLiveRepository;

  beforeAll(async () => {
    t = createTestDb(2);
    repo = new DashboardLiveRepository(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Org mới + chủ; mỗi test một org riêng. */
  const newOrg = async () => {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    return { orgId: org.id, ownerId: owner.id };
  };
  const newMember = async (orgId: string) => {
    const u = await insertUser(t.db);
    await addMember(t.db, orgId, u.id);
    return u.id;
  };
  const mk = (
    orgId: string,
    ownerId: string | null,
    recordedAt: string,
    over: Partial<typeof meetings.$inferInsert> = {},
  ) => insertMeeting(t.db, orgId, ownerId, { recordedAt: new Date(recordedAt), ...over });
  const del = (id: string) =>
    t.db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, id));
  const upload = (
    orgId: string,
    userId: string,
    meetingId: string | null,
    sizeBytes: number,
    status: 'initiated' | 'completed' | 'aborted' | 'expired' = 'completed',
  ) =>
    insertUpload(t.db, orgId, userId, {
      sizeBytes,
      totalParts: Math.ceil(sizeBytes / (8 * MiB)),
      status,
      ...(status === 'completed' ? { meetingId, completedAt: new Date() } : {}),
    });
  const item = (
    orgId: string,
    meetingId: string,
    over: Partial<typeof actionItems.$inferInsert> = {},
  ) =>
    t.db.insert(actionItems).values({
      orgId,
      meetingId,
      origin: 'manual',
      task: 'Việc bí mật',
      ...over,
    });

  describe('memberCounts', () => {
    it('total = số thành viên; active = chủ meeting KHÁC NHAU trong khoảng, biên giờ VN', async () => {
      const { orgId, ownerId } = await newOrg(); // total 1
      const a = await newMember(orgId);
      const b = await newMember(orgId);
      await newMember(orgId); // không họp gì → không hoạt động
      const c = await newMember(orgId); // chỉ có meeting ngoài khoảng
      // owner: 2 meeting trong khoảng (đếm 1 người), a: đúng biên đầu, b: đúng biên cuối
      await mk(orgId, ownerId, MID);
      await mk(orgId, ownerId, MID);
      await mk(orgId, a, IN_FIRST);
      await mk(orgId, b, IN_LAST);
      await mk(orgId, c, BEFORE);
      await mk(orgId, c, AFTER);
      expect(await repo.memberCounts(orgId, FROM, TO)).toEqual({ total: 5, active: 3 });
      // Khoảng một ngày [11, 11]: chỉ owner (MID) nằm trong.
      expect(await repo.memberCounts(orgId, '2026-05-11', '2026-05-11')).toEqual({
        total: 5,
        active: 1,
      });
    });

    it('meeting đã xoá không làm người đó hoạt động', async () => {
      const { orgId, ownerId } = await newOrg();
      const a = await newMember(orgId);
      await mk(orgId, ownerId, MID);
      const gone = await mk(orgId, a, MID);
      await del(gone.id);
      expect(await repo.memberCounts(orgId, FROM, TO)).toEqual({ total: 2, active: 1 });
    });

    it('chủ đã rời org (owner_id NULL) không được đếm, tổng giảm theo', async () => {
      const { orgId, ownerId } = await newOrg();
      const leaver = await newMember(orgId);
      await mk(orgId, ownerId, MID);
      const m = await mk(orgId, leaver, MID);
      await t.db.delete(organizationMembers).where(eq(organizationMembers.userId, leaver));
      const [row] = await t.db.select().from(meetings).where(eq(meetings.id, m.id));
      expect(row?.ownerId).toBeNull(); // nền tảng: rời org → owner_id NULL
      await mk(orgId, null, MID); // thêm một meeting mồ côi
      expect(await repo.memberCounts(orgId, FROM, TO)).toEqual({ total: 1, active: 1 });
    });

    it('org khác không lẫn vào', async () => {
      const { orgId, ownerId } = await newOrg();
      const other = await newOrg();
      await newMember(other.orgId);
      await mk(other.orgId, other.ownerId, MID);
      await mk(orgId, ownerId, MID);
      expect(await repo.memberCounts(orgId, FROM, TO)).toEqual({ total: 1, active: 1 });
    });

    it('org chưa ai họp → active 0', async () => {
      const { orgId } = await newOrg();
      expect(await repo.memberCounts(orgId, FROM, TO)).toEqual({ total: 1, active: 0 });
    });
  });

  describe('storage', () => {
    it('cộng upload completed của meeting chưa xoá; initiated / aborted / expired / meeting đã xoá không tính', async () => {
      const { orgId, ownerId } = await newOrg();
      const m1 = await mk(orgId, ownerId, MID);
      const m2 = await mk(orgId, ownerId, MID);
      const m3 = await mk(orgId, ownerId, MID); // bị xoá
      await upload(orgId, ownerId, m1.id, 2 * GiB);
      await upload(orgId, ownerId, m2.id, 2 * GiB); // tổng 4 GiB > 2^31
      await upload(orgId, ownerId, m3.id, 100 * MiB);
      await del(m3.id);
      await upload(orgId, ownerId, null, 50 * MiB, 'initiated');
      await upload(orgId, ownerId, null, 60 * MiB, 'aborted');
      await upload(orgId, ownerId, null, 70 * MiB, 'expired');
      const s = await repo.storage(orgId);
      expect(s).toEqual({ bytes: 4 * GiB, meetings: 2 });
      expect(typeof s.bytes).toBe('number');
      expect(typeof s.meetings).toBe('number');
    });

    it('là ảnh chụp hiện tại: không phụ thuộc recorded_at của meeting', async () => {
      const { orgId, ownerId } = await newOrg();
      const old = await mk(orgId, ownerId, '2020-01-01T00:00:00Z');
      await upload(orgId, ownerId, old.id, 7 * MiB);
      expect(await repo.storage(orgId)).toEqual({ bytes: 7 * MiB, meetings: 1 });
    });

    it('org khác không lẫn; org rỗng → 0', async () => {
      const { orgId, ownerId } = await newOrg();
      const other = await newOrg();
      const om = await mk(other.orgId, other.ownerId, MID);
      await upload(other.orgId, other.ownerId, om.id, 9 * MiB);
      expect(await repo.storage(orgId)).toEqual({ bytes: 0, meetings: 0 });
      const m = await mk(orgId, ownerId, MID);
      await upload(orgId, ownerId, m.id, 5 * MiB);
      expect(await repo.storage(orgId)).toEqual({ bytes: 5 * MiB, meetings: 1 });
    });
  });

  describe('topChannels', () => {
    /** Tạo `n` meeting (owner cho sẵn) và share vào kênh. */
    const fill = async (orgId: string, ownerId: string, channelId: string, n: number, at = MID) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const m = await mk(orgId, ownerId, at);
        await shareMeeting(t.db, orgId, m.id, channelId);
        ids.push(m.id);
      }
      return ids;
    };

    it('xếp theo số meeting giảm, rồi tên tăng; tôn trọng limit; kênh 0 meeting vắng mặt', async () => {
      const { orgId, ownerId } = await newOrg();
      const big = await insertChannel(t.db, orgId, ownerId, { name: 'zz-lon' });
      const b = await insertChannel(t.db, orgId, ownerId, { name: 'b-kenh' });
      const a = await insertChannel(t.db, orgId, ownerId, { name: 'a-kenh' });
      await insertChannel(t.db, orgId, ownerId, { name: 'rong' }); // 0 meeting
      const outside = await insertChannel(t.db, orgId, ownerId, { name: 'ngoai-khoang' });
      await fill(orgId, ownerId, big.id, 3);
      await fill(orgId, ownerId, b.id, 1);
      await fill(orgId, ownerId, a.id, 1);
      await fill(orgId, ownerId, outside.id, 5, AFTER);
      expect(await repo.topChannels(orgId, FROM, TO, 10)).toEqual([
        { channelId: big.id, name: 'zz-lon', meetings: 3 },
        { channelId: a.id, name: 'a-kenh', meetings: 1 },
        { channelId: b.id, name: 'b-kenh', meetings: 1 },
      ]);
      expect(await repo.topChannels(orgId, FROM, TO, 2)).toEqual([
        { channelId: big.id, name: 'zz-lon', meetings: 3 },
        { channelId: a.id, name: 'a-kenh', meetings: 1 },
      ]);
      expect(await repo.topChannels(orgId, FROM, TO, 1)).toHaveLength(1);
    });

    it('lấy ngày từ bản chép meeting_shares.recorded_at, không từ meetings', async () => {
      const { orgId, ownerId } = await newOrg();
      const c = await insertChannel(t.db, orgId, ownerId, { name: 'ban-chep' });
      const [m] = await fill(orgId, ownerId, c.id, 1); // meeting trong khoảng
      await t.db
        .update(meetingShares)
        .set({ recordedAt: new Date(AFTER) })
        .where(eq(meetingShares.meetingId, m!));
      expect(await repo.topChannels(orgId, FROM, TO, 5)).toEqual([]);
    });

    it('biên ngày VN theo recorded_at của share', async () => {
      const { orgId, ownerId } = await newOrg();
      const c = await insertChannel(t.db, orgId, ownerId, { name: 'bien' });
      await fill(orgId, ownerId, c.id, 1, BEFORE);
      await fill(orgId, ownerId, c.id, 1, IN_FIRST);
      await fill(orgId, ownerId, c.id, 1, IN_LAST);
      await fill(orgId, ownerId, c.id, 1, AFTER);
      expect(await repo.topChannels(orgId, FROM, TO, 5)).toEqual([
        { channelId: c.id, name: 'bien', meetings: 2 },
      ]);
    });

    it('meeting đã xoá không tính; kênh đã xoá bị loại; kênh riêng tư và lưu trữ vẫn vào', async () => {
      const { orgId, ownerId } = await newOrg();
      const live = await insertChannel(t.db, orgId, ownerId, { name: 'song' });
      const priv = await insertChannel(t.db, orgId, ownerId, {
        name: 'rieng-tu',
        visibility: 'private',
      });
      const arch = await insertChannel(t.db, orgId, ownerId, { name: 'luu-tru' });
      const gone = await insertChannel(t.db, orgId, ownerId, { name: 'da-xoa' });
      await t.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, arch.id));
      await t.db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, gone.id));
      const [d1] = await fill(orgId, ownerId, live.id, 1);
      await fill(orgId, ownerId, live.id, 1);
      await del(d1!);
      await fill(orgId, ownerId, priv.id, 1);
      await fill(orgId, ownerId, arch.id, 1);
      await fill(orgId, ownerId, gone.id, 9);
      const rows = await repo.topChannels(orgId, FROM, TO, 10);
      expect(rows).toEqual([
        { channelId: arch.id, name: 'luu-tru', meetings: 1 },
        { channelId: priv.id, name: 'rieng-tu', meetings: 1 },
        { channelId: live.id, name: 'song', meetings: 1 },
      ]);
      expect(Object.keys(rows[0]!).sort()).toEqual(['channelId', 'meetings', 'name']);
    });

    it('một meeting chia sẻ vào hai kênh được đếm một lần ở mỗi kênh', async () => {
      const { orgId, ownerId } = await newOrg();
      const x = await insertChannel(t.db, orgId, ownerId, { name: 'x' });
      const y = await insertChannel(t.db, orgId, ownerId, { name: 'y' });
      const m = await mk(orgId, ownerId, MID);
      await shareMeeting(t.db, orgId, m.id, x.id);
      await shareMeeting(t.db, orgId, m.id, y.id);
      expect(await repo.topChannels(orgId, FROM, TO, 5)).toEqual([
        { channelId: x.id, name: 'x', meetings: 1 },
        { channelId: y.id, name: 'y', meetings: 1 },
      ]);
    });

    it('org khác không lẫn vào', async () => {
      const { orgId, ownerId } = await newOrg();
      const other = await newOrg();
      const oc = await insertChannel(t.db, other.orgId, other.ownerId, { name: 'org-khac' });
      await fill(other.orgId, other.ownerId, oc.id, 4);
      const c = await insertChannel(t.db, orgId, ownerId, { name: 'cua-toi' });
      await fill(orgId, ownerId, c.id, 1);
      expect(await repo.topChannels(orgId, FROM, TO, 5)).toEqual([
        { channelId: c.id, name: 'cua-toi', meetings: 1 },
      ]);
    });
  });

  describe('actionItemCounts', () => {
    const TODAY = '2026-05-11';

    it('bảng kỳ vọng: open / overdue (hạn hôm nay chưa quá hạn) / done trong khoảng, biên VN', async () => {
      const { orgId, ownerId } = await newOrg();
      const m = await mk(orgId, ownerId, MID);
      await item(orgId, m.id, { dueDate: '2026-05-10' }); // open, quá hạn (hôm qua)
      await item(orgId, m.id, { dueDate: '2026-05-11' }); // open, đúng hôm nay → chưa quá hạn
      await item(orgId, m.id, { dueDate: '2026-05-12' }); // open, tương lai
      await item(orgId, m.id); // open, không hạn
      await item(orgId, m.id, { status: 'dismissed', dueDate: '2026-01-01' }); // không tính
      await item(orgId, m.id, {
        status: 'done',
        dueDate: '2026-01-01',
        completedAt: new Date(IN_FIRST),
      });
      await item(orgId, m.id, { status: 'done', completedAt: new Date(IN_LAST) });
      await item(orgId, m.id, { status: 'done', completedAt: new Date(BEFORE) }); // ngoài
      await item(orgId, m.id, { status: 'done', completedAt: new Date(AFTER) }); // ngoài
      expect(await repo.actionItemCounts(orgId, TODAY, FROM, TO)).toEqual({
        open: 4,
        overdue: 1,
        doneInRange: 2,
      });
      // Đổi "hôm nay" sang ngày sau: hạn 11 trở thành quá hạn.
      expect((await repo.actionItemCounts(orgId, '2026-05-12', FROM, TO)).overdue).toBe(2);
    });

    it('việc của meeting đã xoá không tính ở bất kỳ số nào', async () => {
      const { orgId, ownerId } = await newOrg();
      const live = await mk(orgId, ownerId, MID);
      const gone = await mk(orgId, ownerId, MID);
      await item(orgId, live.id, { dueDate: '2026-05-01' });
      await item(orgId, gone.id, { dueDate: '2026-05-01' });
      await item(orgId, gone.id, { status: 'done', completedAt: new Date(MID) });
      await del(gone.id);
      expect(await repo.actionItemCounts(orgId, TODAY, FROM, TO)).toEqual({
        open: 1,
        overdue: 1,
        doneInRange: 0,
      });
    });

    it('org khác không lẫn vào; org rỗng → 0', async () => {
      const { orgId, ownerId } = await newOrg();
      const other = await newOrg();
      const om = await mk(other.orgId, other.ownerId, MID);
      await item(other.orgId, om.id, { dueDate: '2026-05-01' });
      await item(other.orgId, om.id, { status: 'done', completedAt: new Date(MID) });
      expect(await repo.actionItemCounts(orgId, TODAY, FROM, TO)).toEqual({
        open: 0,
        overdue: 0,
        doneInRange: 0,
      });
      const m = await mk(orgId, ownerId, MID);
      await item(orgId, m.id);
      expect(await repo.actionItemCounts(orgId, TODAY, FROM, TO)).toEqual({
        open: 1,
        overdue: 0,
        doneInRange: 0,
      });
    });

    it('kết quả là number thuần', async () => {
      const { orgId } = await newOrg();
      const r = await repo.actionItemCounts(orgId, TODAY, FROM, TO);
      expect(Object.values(r).every((v) => typeof v === 'number')).toBe(true);
    });
  });
});
