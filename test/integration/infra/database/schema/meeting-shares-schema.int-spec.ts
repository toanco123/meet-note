import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPgError } from '../../../../../src/common/errors/pg-error.js';
import {
  channels,
  meetings,
  meetingShares,
  organizationMembers,
} from '../../../../../src/infra/database/schema/index.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../../support/db.js';

async function pgErrorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return findPgError(error);
  }
  throw new Error('Kỳ vọng câu lệnh bị Postgres từ chối nhưng nó chạy thành công');
}

/** Bất biến của `meeting_shares` mà DB tự giữ, kể cả khi code có bug (M6b B1). */
describe('Schema meeting_shares (Postgres thật)', () => {
  let t: TestDb;

  beforeAll(() => {
    t = createTestDb();
  });

  afterAll(async () => {
    await t.close();
  });

  const sharesOf = async (meetingId: string) =>
    (
      await t.db
        .select({ channelId: meetingShares.channelId })
        .from(meetingShares)
        .where(eq(meetingShares.meetingId, meetingId))
    ).map((r) => r.channelId);

  async function orgWithChannel() {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const channel = await insertChannel(t.db, org.id, owner.id);
    const meeting = await insertMeeting(t.db, org.id, owner.id);
    return { owner, org, channel, meeting };
  }

  it.each([
    ['meeting của org A → kênh của org B', 'meeting'],
    ['kênh của org B ← meeting của org A (khai org_id của kênh)', 'channel'],
  ] as const)('share chéo tổ chức (%s) → FK chặn 23503', async (_label, side) => {
    const a = await orgWithChannel();
    const b = await orgWithChannel();
    // Khai org_id của bên nào thì FK của BÊN KIA phải chặn.
    const orgId = side === 'meeting' ? a.org.id : b.org.id;

    const error = await pgErrorOf(shareMeeting(t.db, orgId, a.meeting.id, b.channel.id));

    expect([error?.code, error?.constraint]).toEqual([
      '23503',
      side === 'meeting' ? 'meeting_shares_channel_fk' : 'meeting_shares_meeting_fk',
    ]);
  });

  it('share 2 lần cùng kênh → PK chặn 23505 (service dùng ON CONFLICT DO NOTHING)', async () => {
    const { org, channel, meeting, owner } = await orgWithChannel();
    await shareMeeting(t.db, org.id, meeting.id, channel.id, owner.id);

    const error = await pgErrorOf(shareMeeting(t.db, org.id, meeting.id, channel.id, owner.id));

    expect([error?.code, error?.constraint]).toEqual(['23505', 'meeting_shares_pk']);
  });

  it('purge kênh (xoá cứng) → share mất, meeting còn (D3)', async () => {
    const { org, channel, meeting } = await orgWithChannel();
    await shareMeeting(t.db, org.id, meeting.id, channel.id);

    await t.db.delete(channels).where(eq(channels.id, channel.id));

    const [row] = await t.db.select().from(meetings).where(eq(meetings.id, meeting.id));
    expect([row?.id, await sharesOf(meeting.id)]).toEqual([meeting.id, []]);
  });

  it('chủ meeting bị gỡ khỏi org → meeting còn (owner NULL), share còn — meeting vẫn thuộc kênh', async () => {
    const { org, channel } = await orgWithChannel();
    const member = await insertUser(t.db);
    await addMember(t.db, org.id, member.id);
    const meeting = await insertMeeting(t.db, org.id, member.id);
    await shareMeeting(t.db, org.id, meeting.id, channel.id, member.id);

    await t.db
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, org.id), eq(organizationMembers.userId, member.id)));

    const [row] = await t.db.select().from(meetings).where(eq(meetings.id, meeting.id));
    expect([row?.ownerId, row?.orgId, await sharesOf(meeting.id)]).toEqual([
      null,
      org.id,
      [channel.id],
    ]);
  });

  it('xoá cứng meeting → share mất theo', async () => {
    const { org, channel, meeting } = await orgWithChannel();
    await shareMeeting(t.db, org.id, meeting.id, channel.id);

    await t.db.delete(meetings).where(eq(meetings.id, meeting.id));

    expect(await sharesOf(meeting.id)).toEqual([]);
  });
});
