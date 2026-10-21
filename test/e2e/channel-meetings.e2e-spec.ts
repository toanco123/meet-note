import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { channels, meetings, meetingShares } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('GET /channels/:channelId/meetings (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let orgId: string;
  let owner: TestUser;
  let orgAdmin: TestUser;
  let host: TestUser;
  let member: TestUser;
  let outsider: TestUser;

  const http = () => request(app.getHttpServer());
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const list = (who: TestUser, channelId: string, query: Record<string, string | number> = {}) =>
    http().get(`/v1/orgs/${orgId}/channels/${channelId}/meetings`).query(query).set(as(who));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    const users: TestUser[] = [];
    for (let i = 0; i < 5; i++) users.push(await registerUser(app));
    [owner, orgAdmin, host, member, outsider] = users as [
      TestUser,
      TestUser,
      TestUser,
      TestUser,
      TestUser,
    ];
    orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Kênh' }).expect(201)).body
      .data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [host, member, outsider]) await addMember(db, orgId, u.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it('ai đọc được: thành viên / người ngoài kênh công khai (kể cả lưu trữ); riêng tư: ngoài → 404, Admin org → 403', async () => {
    const priv = (await insertChannel(db, orgId, host.id, { visibility: 'private' })).id;
    const pub = (await insertChannel(db, orgId, host.id, { visibility: 'public' })).id;
    const arch = (await insertChannel(db, orgId, host.id, { visibility: 'public' })).id;
    const gone = (await insertChannel(db, orgId, host.id, { visibility: 'public' })).id;
    await addChannelMember(db, { id: priv }, orgId, member.id, 'guest');
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, arch));
    await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, gone));

    const cases: Array<[string, TestUser, string, number]> = [
      ['khách trong kênh riêng tư', member, priv, 200],
      ['ngoài kênh riêng tư', outsider, priv, 404],
      ['Admin org, kênh riêng tư (D2)', orgAdmin, priv, 403],
      ['ngoài kênh công khai', outsider, pub, 200],
      ['ngoài kênh công khai đã lưu trữ (Q1)', outsider, arch, 200],
      ['kênh đã xoá', host, gone, 404],
    ];
    const results = await Promise.all(
      cases.map(async ([label, who, ch]) => [label, (await list(who, ch)).status]),
    );
    expect(results).toEqual(cases.map(([label, , , status]) => [label, status]));
  });

  it('mới share trước; meeting đã xoá không hiện; đi hết trang khi nhiều share TRÙNG shared_at', async () => {
    const ch = (await insertChannel(db, orgId, host.id, { visibility: 'public' })).id;
    const at = [new Date('2026-10-20T01:00:00Z'), new Date('2026-10-21T01:00:00Z')];
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const m = (await insertMeeting(db, orgId, host.id)).id;
      await shareMeeting(db, orgId, m, ch, host.id);
      // 4 cái cùng mốc mới, 3 cái cùng mốc cũ: limit 3 → biên trang rơi GIỮA nhóm.
      await db
        .update(meetingShares)
        .set({ sharedAt: at[i < 4 ? 1 : 0] })
        .where(eq(meetingShares.meetingId, m));
      ids.push(m);
    }
    const deleted = ids.pop() as string;
    await db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, deleted));

    const seen: Array<{ id: string; sharedAt: string }> = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await list(
        outsider,
        ch,
        cursor ? { limit: 3, cursor } : { limit: 3 },
      ).expect(200);
      seen.push(...(res.body.data as Array<{ id: string; sharedAt: string }>));
      cursor = res.body.meta.nextCursor;
    } while (cursor);

    const expected = [...seen].sort((a, b) =>
      a.sharedAt === b.sharedAt ? b.id.localeCompare(a.id) : b.sharedAt.localeCompare(a.sharedAt),
    );
    expect(seen.map((m) => m.id)).toEqual(expected.map((m) => m.id));
    expect(seen.map((m) => m.id).sort()).toEqual([...ids].sort());
  });
});
