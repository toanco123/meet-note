import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../src/infra/database/database.module.js';
import type { Database } from '../../src/infra/database/database.types.js';
import { auditLogs, channelMembers, channels } from '../../src/infra/database/schema/index.js';
import { createTestApp } from '../support/app.js';
import { addChannelMember, addMember } from '../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../support/factories.js';

describe('Kênh: tham gia / rời / chuyển chủ kênh (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  // alice = Chủ kênh; bob = QTV; carol = thành viên; gina = Khách (trong mọi kênh `freshChannel`).
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
  const url = (channelId: string, action: string) =>
    `/v1/orgs/${orgId}/channels/${channelId}/${action}`;
  const post = (who: TestUser, channelId: string, action: string, body: object = {}) =>
    http().post(url(channelId, action)).set(bearer(who.tokens.accessToken)).send(body);

  async function freshChannel(visibility: 'public' | 'private' = 'private') {
    const res = await http()
      .post(`/v1/orgs/${orgId}/channels`)
      .set(bearer(alice.tokens.accessToken))
      .send({ name: `kênh-${randomUUID()}`, visibility })
      .expect(201);
    const channel = { id: res.body.id as string };
    await addChannelMember(db, channel, orgId, bob.id, 'admin');
    await addChannelMember(db, channel, orgId, carol.id, 'member');
    await addChannelMember(db, channel, orgId, gina.id, 'guest');
    return channel;
  }

  const archive = (channelId: string) =>
    db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId));

  const roleOf = async (channelId: string, userId: string) =>
    (
      await db
        .select({ role: channelMembers.role })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    )[0]?.role ?? 'gone';

  const actionsOn = async (channelId: string) =>
    (await db.select().from(auditLogs).where(eq(auditLogs.targetId, channelId))).map(
      (l) => l.action,
    );

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
        .send({ name: 'Tham gia & chuyển chủ' })
        .expect(201)
    ).body.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [alice, bob, carol, gina, outsider]) await addMember(db, orgId, u.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST .../join', () => {
    it('kênh công khai: thành viên org tham gia → 200 (myRole member); lần 2 → 409; có audit', async () => {
      const ch = await freshChannel('public');

      const res = await post(outsider, ch.id, 'join').expect(200);
      expect(res.body).toMatchObject({ id: ch.id, myRole: 'member', memberCount: 5 });

      const again = await post(outsider, ch.id, 'join').expect(409);
      expect(again.body.error.code).toBe('CHANNEL_ALREADY_MEMBER');
      expect(await actionsOn(ch.id)).toContain('channel.member.joined');
    });

    it.each([
      ['thành viên org ngoài kênh riêng tư → 404 (không thấy kênh)', 404, () => outsider],
      [
        'Admin org (không trong kênh) → 403 (thấy nhưng không tự vào kênh riêng tư)',
        403,
        () => orgAdmin,
      ],
      ['người đã trong kênh riêng tư → 409', 409, () => carol],
      ['người ngoài tổ chức → 404', 404, () => stranger],
    ] as const)('kênh riêng tư — %s', async (_label, status, who) => {
      const ch = await freshChannel('private');
      const res = await post(who(), ch.id, 'join');
      expect(res.status).toBe(status);
    });

    it('kênh công khai đã lưu trữ → 409 CHANNEL_ARCHIVED', async () => {
      const ch = await freshChannel('public');
      await archive(ch.id);
      const res = await post(outsider, ch.id, 'join').expect(409);
      expect(res.body.error.code).toBe('CHANNEL_ARCHIVED');
      expect(await roleOf(ch.id, outsider.id)).toBe('gone');
    });
  });

  describe('POST .../leave', () => {
    it.each([
      ['QTV kênh', 204, () => bob],
      ['thành viên kênh', 204, () => carol],
      ['Khách', 204, () => gina],
      ['Admin org (không trong kênh)', 403, () => orgAdmin],
      ['thành viên org ngoài kênh riêng tư', 404, () => outsider],
    ] as const)('%s → %i', async (_label, status, who) => {
      const ch = await freshChannel();
      const res = await post(who(), ch.id, 'leave');
      expect(res.status).toBe(status);
      // Rời được → đã bị xoá; không rời được ở đây đều là người vốn KHÔNG ở trong kênh.
      expect(await roleOf(ch.id, who().id)).toBe('gone');
    });

    it('Chủ kênh rời → 409 CHANNEL_OWNER_MUST_TRANSFER; chuyển chủ xong thì rời được', async () => {
      const ch = await freshChannel();

      const res = await post(alice, ch.id, 'leave').expect(409);
      expect(res.body.error.code).toBe('CHANNEL_OWNER_MUST_TRANSFER');

      await post(alice, ch.id, 'ownership-transfer', { newOwnerId: bob.id }).expect(200);
      await post(alice, ch.id, 'leave').expect(204);
      expect([await roleOf(ch.id, alice.id), await roleOf(ch.id, bob.id)]).toEqual([
        'gone',
        'owner',
      ]);
    });

    it('rời kênh riêng tư → không còn thấy kênh (404); có audit channel.member.left', async () => {
      const ch = await freshChannel();
      await post(carol, ch.id, 'leave').expect(204);

      const res = await http()
        .get(`/v1/orgs/${orgId}/channels/${ch.id}`)
        .set(bearer(carol.tokens.accessToken));
      expect(res.status).toBe(404);
      expect(await actionsOn(ch.id)).toContain('channel.member.left');
    });

    it('kênh đã lưu trữ vẫn rời được (không ai bị kẹt)', async () => {
      const ch = await freshChannel();
      await archive(ch.id);
      await post(carol, ch.id, 'leave').expect(204);
      expect(await roleOf(ch.id, carol.id)).toBe('gone');
    });
  });

  describe('POST .../ownership-transfer', () => {
    it('Chủ kênh chuyển cho QTV → 200; chủ cũ thành QTV; audit before/after', async () => {
      const ch = await freshChannel();

      const res = await post(alice, ch.id, 'ownership-transfer', { newOwnerId: bob.id }).expect(
        200,
      );

      expect(res.body).toEqual({ channelId: ch.id, ownerId: bob.id });
      expect([await roleOf(ch.id, alice.id), await roleOf(ch.id, bob.id)]).toEqual([
        'admin',
        'owner',
      ]);
      const [log] = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.targetId, ch.id), eq(auditLogs.action, 'channel.ownership.transferred')),
        );
      expect(log?.metadata).toEqual({
        before: { ownerId: alice.id, newOwnerRole: 'admin' },
        after: { ownerId: bob.id, previousOwnerRole: 'admin' },
      });
    });

    it.each([
      ['Chủ kênh → thành viên', 200, () => alice, () => carol, null],
      ['Admin org (không trong kênh) chuyển hộ', 200, () => orgAdmin, () => carol, null],
      ['Owner org (không trong kênh) chuyển hộ', 200, () => owner, () => bob, null],
      ['Chủ kênh → Khách', 409, () => alice, () => gina, 'CHANNEL_TRANSFER_INVALID_TARGET'],
      ['Chủ kênh → chính mình', 409, () => alice, () => alice, 'CHANNEL_TRANSFER_INVALID_TARGET'],
      ['Chủ kênh → người chưa vào kênh', 404, () => alice, () => outsider, 'NOT_FOUND'],
      ['Chủ kênh → người ngoài tổ chức', 404, () => alice, () => stranger, 'NOT_FOUND'],
      ['QTV kênh', 403, () => bob, () => carol, 'FORBIDDEN'],
      ['thành viên kênh', 403, () => carol, () => bob, 'FORBIDDEN'],
    ] as const)('%s → %i', async (_label, status, who, target, code) => {
      const ch = await freshChannel();

      const res = await post(who(), ch.id, 'ownership-transfer', { newOwnerId: target().id });

      expect(res.status).toBe(status);
      expect(res.body.error?.code ?? null).toBe(code);
      expect(await roleOf(ch.id, status === 200 ? target().id : alice.id)).toBe('owner');
    });

    it('kênh đã lưu trữ → 409 CHANNEL_ARCHIVED; newOwnerId không phải uuid → 400', async () => {
      const ch = await freshChannel();
      await post(alice, ch.id, 'ownership-transfer', { newOwnerId: 'abc' }).expect(400);
      await archive(ch.id);
      const res = await post(alice, ch.id, 'ownership-transfer', { newOwnerId: bob.id }).expect(
        409,
      );
      expect(res.body.error.code).toBe('CHANNEL_ARCHIVED');
      expect(await roleOf(ch.id, alice.id)).toBe('owner');
    });
  });
});
