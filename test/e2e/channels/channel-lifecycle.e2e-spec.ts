import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { auditLogs } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { addChannelMember, addMember, insertUser } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';

describe('Kênh: lưu trữ / bỏ lưu trữ / xoá (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  // alice = Chủ kênh; bob = QTV; carol = thành viên (trong mọi kênh `freshChannel`).
  let owner: TestUser;
  let orgAdmin: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let outsider: TestUser;
  let orgId: string;

  const http = () => request(app.getHttpServer());
  const base = () => `/v1/orgs/${orgId}/channels`;
  const as = (who: TestUser) => bearer(who.tokens.accessToken);
  const archive = (who: TestUser, id: string, action: 'archive' | 'unarchive' = 'archive') =>
    http().post(`${base()}/${id}/${action}`).set(as(who));
  const remove = (who: TestUser, id: string) => http().delete(`${base()}/${id}`).set(as(who));
  const get = (who: TestUser, id: string) => http().get(`${base()}/${id}`).set(as(who));

  async function freshChannel(name = `kênh-${randomUUID()}`, visibility = 'private') {
    const res = await http().post(base()).set(as(alice)).send({ name, visibility }).expect(201);
    const channel = { id: res.body.data.id as string, name };
    await addChannelMember(db, channel, orgId, bob.id, 'admin');
    await addChannelMember(db, channel, orgId, carol.id, 'member');
    return channel;
  }

  const actionsOn = async (id: string) =>
    (await db.select().from(auditLogs).where(eq(auditLogs.targetId, id))).map((l) => l.action);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DRIZZLE);
    [owner, orgAdmin, alice, bob, carol, outsider] = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    orgId = (
      await http().post('/v1/orgs').set(as(owner)).send({ name: 'Vòng đời kênh' }).expect(201)
    ).body.data.id;
    await addMember(db, orgId, orgAdmin.id, 'admin');
    for (const u of [alice, bob, carol, outsider]) await addMember(db, orgId, u.id, 'member');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST .../archive · .../unarchive', () => {
    it.each([
      ['Chủ kênh', 200, () => alice],
      ['Admin org (không trong kênh)', 200, () => orgAdmin],
      ['Owner org (không trong kênh)', 200, () => owner],
      ['QTV kênh', 403, () => bob],
      ['thành viên kênh', 403, () => carol],
      ['thành viên org ngoài kênh riêng tư', 404, () => outsider],
    ] as const)('lưu trữ: %s → %i', async (_label, status, who) => {
      const ch = await freshChannel();
      const res = await archive(who(), ch.id);
      expect(res.status).toBe(status);
      // 200 → có thời điểm lưu trữ; lỗi → không có `data`.
      expect(typeof res.body.data?.archivedAt).toBe(status === 200 ? 'string' : 'undefined');
    });

    it('lưu trữ lần 2 → 200, không đổi thời điểm, chỉ 1 audit; bỏ lưu trữ → archivedAt null', async () => {
      const ch = await freshChannel();
      const first = await archive(alice, ch.id).expect(200);
      const second = await archive(alice, ch.id).expect(200);
      const restored = await archive(alice, ch.id, 'unarchive').expect(200);

      expect(second.body.data.archivedAt).toBe(first.body.data.archivedAt);
      expect(restored.body.data.archivedAt).toBeNull();
      expect((await actionsOn(ch.id)).filter((a) => a !== 'channel.created')).toEqual([
        'channel.archived',
        'channel.unarchived',
      ]);
    });

    it('kênh lưu trữ = chỉ đọc: ghi → 409, đọc / rời / bỏ lưu trữ vẫn được', async () => {
      const ch = await freshChannel();
      const target = await insertUser(db);
      await addMember(db, orgId, target.id, 'member');
      await archive(alice, ch.id).expect(200);

      const writes = await Promise.all([
        http().patch(`${base()}/${ch.id}`).set(as(alice)).send({ name: 'Không được' }),
        http()
          .post(`${base()}/${ch.id}/members`)
          .set(as(alice))
          .send({ userId: target.id, role: 'member' }),
        http()
          .post(`${base()}/${ch.id}/ownership-transfer`)
          .set(as(alice))
          .send({ newOwnerId: bob.id }),
      ]);
      expect(writes.map((r) => r.body.error?.code)).toEqual([
        'CHANNEL_ARCHIVED',
        'CHANNEL_ARCHIVED',
        'CHANNEL_ARCHIVED',
      ]);

      await get(carol, ch.id).expect(200);
      await http().post(`${base()}/${ch.id}/leave`).set(as(carol)).expect(204);
      await archive(alice, ch.id, 'unarchive').expect(200);
      await http()
        .patch(`${base()}/${ch.id}`)
        .set(as(alice))
        .send({ description: 'mở lại' })
        .expect(200);
    });

    it('danh sách mặc định ẩn kênh lưu trữ; archived=true chỉ hiện kênh lưu trữ', async () => {
      const ch = await freshChannel(`lưu-trữ-${randomUUID()}`, 'public');
      await archive(alice, ch.id).expect(200);
      const ids = async (query: object) =>
        (
          await http()
            .get(base())
            .query({ limit: 100, ...query })
            .set(as(alice))
            .expect(200)
        ).body.data.map((c: { id: string }) => c.id);

      expect([
        (await ids({})).includes(ch.id),
        (await ids({ archived: 'true' })).includes(ch.id),
      ]).toEqual([false, true]);
    });
  });

  describe('DELETE .../:channelId', () => {
    it.each([
      ['Chủ kênh', 204, () => alice],
      ['Admin org (không trong kênh)', 204, () => orgAdmin],
      ['QTV kênh', 403, () => bob],
      ['thành viên kênh', 403, () => carol],
      ['thành viên org ngoài kênh riêng tư', 404, () => outsider],
    ] as const)('%s → %i', async (_label, status, who) => {
      const ch = await freshChannel();
      const res = await remove(who(), ch.id);
      expect(res.status).toBe(status);
    });

    it('xoá mềm → 404 với MỌI người (kể cả chủ, Owner org); xoá lần 2 → 404; có audit', async () => {
      const ch = await freshChannel();
      await remove(alice, ch.id).expect(204);

      const statuses = await Promise.all(
        [alice, owner, carol].map(async (u) => (await get(u, ch.id)).status),
      );
      expect(statuses).toEqual([404, 404, 404]);
      await remove(alice, ch.id).expect(404);
      expect(await actionsOn(ch.id)).toContain('channel.deleted');
    });

    it('tên kênh đã xoá dùng lại được ngay; kênh đã xoá không còn trong danh sách', async () => {
      const name = `tái-sử-dụng-${randomUUID()}`;
      const ch = await freshChannel(name, 'public');
      await remove(alice, ch.id).expect(204);

      const again = await http().post(base()).set(as(bob)).send({ name }).expect(201);
      const list = await http().get(base()).query({ q: name }).set(as(owner)).expect(200);
      expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([again.body.data.id]);
    });

    it('xoá được kênh đang lưu trữ', async () => {
      const ch = await freshChannel();
      await archive(alice, ch.id).expect(200);
      const res = await remove(alice, ch.id);
      expect(res.status).toBe(204);
    });
  });
});
