import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  auditLogs,
  channelMembers,
  type ChannelRoleValue,
  channels,
} from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addChannelMember, addMember, insertUser } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

interface MemberBody {
  userId: string;
  displayName: string;
  role: string;
  joinedAt: string;
}

type Grantable = Exclude<ChannelRoleValue, 'owner'>;

describe('Thành viên kênh (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  // alice = Chủ kênh; bob = QTV; carol = thành viên; gina = Khách (trong mọi kênh `freshChannel`).
  // orgAdmin = Admin org không ở trong kênh; outsider = thành viên org ngoài kênh; stranger = ngoài org.
  let owner: TestUser;
  let orgAdmin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let gina: TestUser;
  let outsider: TestUser;
  let stranger: TestUser;
  let orgId: string;

  const http = () => request(app.getHttpServer());
  const membersUrl = (channelId: string) => `/v1/orgs/${orgId}/channels/${channelId}/members`;

  /** Kênh mới với đủ 4 vai trò → mỗi test ghi không ảnh hưởng test khác. */
  async function freshChannel(visibility: 'public' | 'private' = 'private') {
    const res = await http()
      .post(`/v1/orgs/${orgId}/channels`)
      .set(bearer(alice.tokens.accessToken))
      .send({ name: `kênh-${randomUUID()}`, visibility })
      .expect(201);
    const channel = { id: res.body.data.id as string };
    await addChannelMember(db, channel, orgId, bob.id, 'admin');
    await addChannelMember(db, channel, orgId, carol.id, 'member');
    await addChannelMember(db, channel, orgId, gina.id, 'guest');
    return channel;
  }

  /** Một thành viên org mới; `role` có → đưa luôn vào kênh với vai trò đó. */
  async function newTarget(channel?: { id: string }, role?: Grantable, displayName?: string) {
    const user = await insertUser(db, displayName ? { displayName } : {});
    await addMember(db, orgId, user.id, 'member');
    if (channel && role) await addChannelMember(db, channel, orgId, user.id, role);
    return user;
  }

  const roleOf = async (channelId: string, userId: string) =>
    (
      await db
        .select({ role: channelMembers.role })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    )[0]?.role ?? 'gone';

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, orgAdmin, alice, bob, carol, gina, outsider, stranger] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'Thành viên kênh' })
        .expect(201)
    ).body.data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [alice, bob, carol, gina, outsider]) await addMember(db, orgId, u.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET .../members', () => {
    let priv: { id: string };

    beforeAll(async () => {
      priv = await freshChannel('private');
    });

    it.each([
      ['Chủ kênh', 200, () => alice],
      ['QTV kênh', 200, () => bob],
      ['thành viên kênh', 200, () => carol],
      ['Khách → 403', 403, () => gina],
      ['Admin org (không trong kênh)', 200, () => orgAdmin],
      ['thành viên org ngoài kênh riêng tư → 404', 404, () => outsider],
      ['người ngoài tổ chức → 404', 404, () => stranger],
    ] as const)('kênh riêng tư — %s → %i', async (_label, status, who) => {
      const res = await http().get(membersUrl(priv.id)).set(bearer(who().tokens.accessToken));
      expect(res.status).toBe(status);
    });

    it('kênh công khai — thành viên org chưa join xem được', async () => {
      const pub = await freshChannel('public');
      const res = await http()
        .get(membersUrl(pub.id))
        .set(bearer(outsider.tokens.accessToken))
        .expect(200);
      expect(res.body.data.map((m: MemberBody) => m.role)).toEqual([
        'owner',
        'admin',
        'member',
        'guest',
      ]);
    });

    it('phân trang theo thời điểm tham gia: không trùng, không sót, đúng thứ tự', async () => {
      const ch = await freshChannel();
      for (let i = 0; i < 12; i++) await newTarget(ch, 'member');

      const seen: MemberBody[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { data: MemberBody[]; meta: { nextCursor: string | null } } } =
          await http()
            .get(membersUrl(ch.id))
            .query(cursor ? { limit: 5, cursor } : { limit: 5 })
            .set(bearer(alice.tokens.accessToken))
            .expect(200);
        seen.push(...res.body.data);
        cursor = res.body.meta.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(16);
      expect(new Set(seen.map((m) => m.userId)).size).toBe(16);
      const times = seen.map((m) => Date.parse(m.joinedAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('q tìm không dấu; role lọc theo vai trò', async () => {
      const ch = await freshChannel();
      const bich = await newTarget(ch, 'member', 'Trần Thị Bích');

      const byName = await http()
        .get(membersUrl(ch.id))
        .query({ q: 'tran thi BICH' })
        .set(bearer(alice.tokens.accessToken))
        .expect(200);
      expect(byName.body.data.map((m: MemberBody) => m.userId)).toEqual([bich.id]);

      const guests = await http()
        .get(membersUrl(ch.id))
        .query({ role: 'guest' })
        .set(bearer(alice.tokens.accessToken))
        .expect(200);
      expect(guests.body.data.map((m: MemberBody) => m.userId)).toEqual([gina.id]);
    });

    it('cursor hỏng → 400 INVALID_CURSOR', async () => {
      const res = await http()
        .get(membersUrl(priv.id))
        .query({ cursor: 'rác' })
        .set(bearer(alice.tokens.accessToken))
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    });
  });

  describe('POST .../members', () => {
    const add = (who: TestUser, channelId: string, body: object) =>
      http().post(membersUrl(channelId)).set(bearer(who.tokens.accessToken)).send(body);

    it.each([
      ['Chủ kênh thêm QTV', 201, () => alice, 'admin'],
      ['Chủ kênh thêm khách', 201, () => alice, 'guest'],
      ['QTV thêm thành viên', 201, () => bob, 'member'],
      ['QTV thêm khách', 201, () => bob, 'guest'],
      ['QTV thêm QTV (ngang mình)', 403, () => bob, 'admin'],
      ['thành viên thêm người', 403, () => carol, 'member'],
      ['Khách thêm người', 403, () => gina, 'member'],
      ['Admin org (không trong kênh) thêm người', 403, () => orgAdmin, 'member'],
      ['thành viên org ngoài kênh riêng tư', 404, () => outsider, 'member'],
    ] as const)('%s → %i', async (_label, status, who, role) => {
      const ch = await freshChannel();
      const target = await newTarget();

      const res = await add(who(), ch.id, { userId: target.id, role });

      expect(res.status).toBe(status);
      expect(await roleOf(ch.id, target.id)).toBe(status === 201 ? role : 'gone');
    });

    it('201 trả thông tin thành viên + audit channel.member.added', async () => {
      const ch = await freshChannel();
      const target = await newTarget(undefined, undefined, 'Lê Văn Cường');

      const res = await add(alice, ch.id, { userId: target.id, role: 'member' }).expect(201);

      expect(res.body.data).toMatchObject({
        userId: target.id,
        displayName: 'Lê Văn Cường',
        role: 'member',
      });
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.member.added')));
      expect(log).toMatchObject({
        actorId: alice.id,
        metadata: { userId: target.id, after: { role: 'member' } },
      });
    });

    it('đã ở trong kênh → 409 CHANNEL_ALREADY_MEMBER (vai trò cũ giữ nguyên)', async () => {
      const ch = await freshChannel();
      const res = await add(alice, ch.id, { userId: carol.id, role: 'admin' }).expect(409);
      expect(res.body.error.code).toBe('CHANNEL_ALREADY_MEMBER');
      expect(await roleOf(ch.id, carol.id)).toBe('member');
    });

    it('người không thuộc tổ chức → 404', async () => {
      const ch = await freshChannel();
      const res = await add(alice, ch.id, { userId: stranger.id, role: 'member' }).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it.each([
      ["role 'owner'", { role: 'owner' }],
      ['userId không phải uuid', { userId: 'abc', role: 'member' }],
      ['thiếu role', {}],
    ])('%s → 400', async (_label, body) => {
      const ch = await freshChannel();
      const target = await newTarget();
      const res = await add(alice, ch.id, { userId: target.id, ...body }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('kênh đã lưu trữ → 409 CHANNEL_ARCHIVED', async () => {
      const ch = await freshChannel();
      await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch.id));
      const target = await newTarget();

      const res = await add(alice, ch.id, { userId: target.id, role: 'member' }).expect(409);
      expect(res.body.error.code).toBe('CHANNEL_ARCHIVED');
    });
  });

  describe('PATCH .../members/:userId', () => {
    const change = (who: TestUser, channelId: string, userId: string, role: string) =>
      http()
        .patch(`${membersUrl(channelId)}/${userId}`)
        .set(bearer(who.tokens.accessToken))
        .send({ role });

    it.each([
      ['Chủ kênh: thành viên → QTV', 200, () => alice, 'member', 'admin'],
      ['Chủ kênh: QTV → khách', 200, () => alice, 'admin', 'guest'],
      ['QTV: thành viên → khách', 200, () => bob, 'member', 'guest'],
      ['QTV: khách → thành viên', 200, () => bob, 'guest', 'member'],
      ['QTV: thành viên → QTV (ngang mình)', 403, () => bob, 'member', 'admin'],
      ['QTV: hạ QTV khác', 403, () => bob, 'admin', 'member'],
      ['thành viên: khách → thành viên', 403, () => carol, 'guest', 'member'],
      ['Admin org (không trong kênh)', 403, () => orgAdmin, 'member', 'guest'],
    ] as const)('%s → %i', async (_label, status, who, from, to) => {
      const ch = await freshChannel();
      const target = await newTarget(ch, from);

      const res = await change(who(), ch.id, target.id, to);

      expect(res.status).toBe(status);
      expect(await roleOf(ch.id, target.id)).toBe(status === 200 ? to : from);
    });

    it.each([
      ['Chủ kênh tự đổi mình', () => alice],
      ['QTV đổi Chủ kênh', () => bob],
    ] as const)('%s → 409 CHANNEL_OWNER_IMMUTABLE', async (_label, who) => {
      const ch = await freshChannel();
      const res = await change(who(), ch.id, alice.id, 'member').expect(409);
      expect(res.body.error.code).toBe('CHANNEL_OWNER_IMMUTABLE');
      expect(await roleOf(ch.id, alice.id)).toBe('owner');
    });

    it("role 'owner' → 400 (đổi chủ = chuyển chủ kênh)", async () => {
      const ch = await freshChannel();
      await change(alice, ch.id, carol.id, 'owner').expect(400);
      expect(await roleOf(ch.id, carol.id)).toBe('member');
    });

    it('người không ở trong kênh → 404', async () => {
      const ch = await freshChannel();
      const res = await change(alice, ch.id, outsider.id, 'guest').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('đổi vai trò → audit before/after; đổi sang vai trò đang có → 200, không audit thêm', async () => {
      const ch = await freshChannel();
      const target = await newTarget(ch, 'member');

      await change(alice, ch.id, target.id, 'guest').expect(200);
      const same = await change(alice, ch.id, target.id, 'guest').expect(200);

      expect(same.body.data.role).toBe('guest');
      const logs = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.member.role_changed')),
        );
      expect(logs.map((l) => l.metadata)).toEqual([
        { userId: target.id, before: { role: 'member' }, after: { role: 'guest' } },
      ]);
    });
  });

  describe('DELETE .../members/:userId', () => {
    const remove = (who: TestUser, channelId: string, userId: string) =>
      http()
        .delete(`${membersUrl(channelId)}/${userId}`)
        .set(bearer(who.tokens.accessToken));

    it.each([
      ['Chủ kênh gỡ QTV', 204, () => alice, 'admin'],
      ['Chủ kênh gỡ khách', 204, () => alice, 'guest'],
      ['QTV gỡ thành viên', 204, () => bob, 'member'],
      ['QTV gỡ khách', 204, () => bob, 'guest'],
      ['QTV gỡ QTV khác', 403, () => bob, 'admin'],
      ['thành viên gỡ khách', 403, () => carol, 'guest'],
      ['Admin org (không trong kênh)', 403, () => orgAdmin, 'member'],
    ] as const)('%s → %i', async (_label, status, who, targetRole) => {
      const ch = await freshChannel();
      const target = await newTarget(ch, targetRole);

      const res = await remove(who(), ch.id, target.id);

      expect(res.status).toBe(status);
      expect(await roleOf(ch.id, target.id)).toBe(status === 204 ? 'gone' : targetRole);
    });

    it('Chủ kênh tự gỡ mình → 409 CHANNEL_OWNER_IMMUTABLE; QTV tự gỡ mình → 403', async () => {
      const ch = await freshChannel();
      const own = await remove(alice, ch.id, alice.id).expect(409);
      expect(own.body.error.code).toBe('CHANNEL_OWNER_IMMUTABLE');
      await remove(bob, ch.id, bob.id).expect(403);
      expect([await roleOf(ch.id, alice.id), await roleOf(ch.id, bob.id)]).toEqual([
        'owner',
        'admin',
      ]);
    });

    it('gỡ → audit channel.member.removed; người không ở trong kênh → 404; userId rác → 400', async () => {
      const ch = await freshChannel();
      const target = await newTarget(ch, 'guest');

      await remove(alice, ch.id, target.id).expect(204);
      await remove(alice, ch.id, target.id).expect(404);
      await remove(alice, ch.id, 'abc').expect(400);

      const logs = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.member.removed')));
      expect(logs.map((l) => l.metadata)).toEqual([
        { userId: target.id, before: { role: 'guest' } },
      ]);
    });
  });
});
