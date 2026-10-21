import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  channelMembers,
  channels,
  meetings,
  meetingShares,
  organizationMembers,
} from '../../../../src/infra/database/schema/index.js';
import { MeetingSharesRepository } from '../../../../src/modules/meetings/repositories/meeting-shares.repository.js';
import { MeetingsRepository } from '../../../../src/modules/meetings/repositories/meetings.repository.js';
import { MeetingSharesService } from '../../../../src/modules/meetings/services/meeting-shares.service.js';
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
import { interleave } from '../../../support/locks.js';

/**
 * "Dùng quyền" ‖ "mất quyền" — ép thứ tự xen kẽ XÁC ĐỊNH bằng `interleave`: T1 khoá như thao tác
 * đổi quyền thật, T2 (share / gỡ share) phải ĐỢI, rồi T1 đổi trạng thái và commit; T2 phải thấy
 * trạng thái mới. Mỗi test ghi đột biến làm nó đỏ (kết quả trong plan M6b).
 */
describe('Share / gỡ share ‖ mất quyền (Postgres thật)', () => {
  let t: TestDb;
  let service: MeetingSharesService;

  beforeAll(async () => {
    t = createTestDb(6);
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingSharesService,
        MeetingSharesRepository,
        MeetingsRepository,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(MeetingSharesService);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Org + kênh riêng tư; `author` là thành viên kênh, có một meeting. */
  async function world(channelRole: 'member' | 'admin' = 'member') {
    const host = await insertUser(t.db);
    const org = await insertOrg(t.db, host.id);
    const author = await insertUser(t.db);
    await addMember(t.db, org.id, author.id);
    const channel = await insertChannel(t.db, org.id, host.id, { visibility: 'private' });
    await addChannelMember(t.db, channel, org.id, author.id, channelRole);
    const meeting = await insertMeeting(t.db, org.id, author.id);
    const membership = { orgId: org.id, role: 'member' as const };
    const shares = async () =>
      (await t.db.select().from(meetingShares).where(eq(meetingShares.meetingId, meeting.id)))
        .length;
    return { org, host, author, channel, meeting, membership, shares };
  }

  // Đột biến: `lockChannel` bỏ `.for('share')` → T2 không đợi, share xong TRƯỚC khi bị gỡ.
  it('share ‖ bị gỡ khỏi kênh (thao tác M4 khoá dòng kênh) → share thấy mình đã bị gỡ: 404, không có share', async () => {
    const w = await world();
    const result = await interleave(t.db, {
      hold: (tx) => tx.select().from(channels).where(eq(channels.id, w.channel.id)).for('update'),
      contend: () => service.share(w.membership, w.author.id, w.meeting.id, w.channel.id),
      afterWait: (tx) =>
        tx
          .delete(channelMembers)
          .where(
            and(eq(channelMembers.channelId, w.channel.id), eq(channelMembers.userId, w.author.id)),
          ),
    });
    expect([result, await w.shares()]).toEqual([{ holder: 'OK', contender: 'NOT_FOUND' }, 0]);
  });

  // Đột biến: như trên — cùng một khoá dòng kênh.
  it('share ‖ lưu trữ kênh → 409 CHANNEL_ARCHIVED, không có share', async () => {
    const w = await world();
    const result = await interleave(t.db, {
      hold: (tx) => tx.select().from(channels).where(eq(channels.id, w.channel.id)).for('update'),
      contend: () => service.share(w.membership, w.author.id, w.meeting.id, w.channel.id),
      afterWait: (tx) =>
        tx.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, w.channel.id)),
    });
    expect([result, await w.shares()]).toEqual([
      { holder: 'OK', contender: 'CHANNEL_ARCHIVED' },
      0,
    ]);
  });

  // Đột biến: `lockMeeting` bỏ `.for('share')` → đọc bản đã commit (chưa xoá), chèn share lên
  // meeting vừa bị xoá.
  it('share ‖ xoá meeting → 404, không có share trên meeting đã xoá', async () => {
    const w = await world();
    const result = await interleave(t.db, {
      hold: (tx) => tx.select().from(meetings).where(eq(meetings.id, w.meeting.id)).for('update'),
      contend: () => service.share(w.membership, w.author.id, w.meeting.id, w.channel.id),
      afterWait: (tx) =>
        tx.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, w.meeting.id)),
    });
    expect([result, await w.shares()]).toEqual([{ holder: 'OK', contender: 'NOT_FOUND' }, 0]);
  });

  /**
   * Gỡ khỏi TỔ CHỨC xoá dòng `channel_members` qua cascade mà KHÔNG đi qua dòng kênh — khoá dòng
   * kênh không bảo vệ được. QTV kênh gỡ meeting của NGƯỜI KHÁC đúng lúc bị gỡ khỏi org.
   * Đột biến: `lockChannelRole` bỏ `.for('share')` → đọc vai trò `admin` đã commit → gỡ được.
   */
  it('QTV gỡ share ‖ QTV bị gỡ khỏi org (cascade) → gỡ share thất bại, share còn nguyên', async () => {
    const w = await world('admin');
    const other = await insertUser(t.db);
    await addMember(t.db, w.org.id, other.id);
    const othersMeeting = await insertMeeting(t.db, w.org.id, other.id);
    await shareMeeting(t.db, w.org.id, othersMeeting.id, w.channel.id, other.id);

    const result = await interleave(t.db, {
      hold: (tx) =>
        tx
          .delete(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, w.org.id),
              eq(organizationMembers.userId, w.author.id),
            ),
          ),
      contend: () => service.unshare(w.membership, w.author.id, othersMeeting.id, w.channel.id),
    });
    const left = await t.db
      .select()
      .from(meetingShares)
      .where(eq(meetingShares.meetingId, othersMeeting.id));
    // Không còn là thành viên kênh riêng tư → không thấy kênh → 404.
    expect([result, left.length]).toEqual([{ holder: 'OK', contender: 'NOT_FOUND' }, 1]);
  });
});
