import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { notifications } from '../../../src/infra/database/schema/index.js';
import { REALTIME_PUBLISHER } from '../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../src/infra/realtime/realtime.types.js';
import { createTestApp } from '../../support/app.js';
import { addChannelMember, addMember, insertChannel } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { connectRealtime, nextEvent, portOf } from '../../support/realtime.js';

/**
 * Nguồn thông báo trong M10 (Q1) đi qua REST thật: đúng dòng trong DB (lưu trong transaction của
 * thao tác) + người nhận đang online nhận `notification.created` SAU commit (Q2).
 */
describe('Thông báo: các nguồn trong transaction (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await app.close();
  });

  const online = async (u: TestUser) => {
    const { socket, outcome } = await connectRealtime(portOf(app), u.tokens.accessToken);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    return socket;
  };
  const notesOf = async (u: TestUser) =>
    db.select().from(notifications).where(eq(notifications.userId, u.id));
  async function org(name: string) {
    const owner = await registerUser(app, { displayName: 'Chủ Org' });
    const id = (await http().post('/v1/orgs').set(as(owner)).send({ name }).expect(201)).body.data
      .id as string;
    return { owner, id };
  }

  it('được thêm vào kênh → thông báo `channel.member_added` + realtime; thêm lại (409) không sinh thêm', async () => {
    const { owner, id: orgId } = await org('Kênh');
    const user = await registerUser(app, { displayName: 'Bình' });
    await addMember(db, orgId, user.id);
    const channel = await insertChannel(db, orgId, owner.id, { name: 'Kỹ thuật' });
    const pushed = nextEvent<{ type: string; payload: Record<string, unknown> }>(
      await online(user),
      'notification.created',
    );

    const add = () =>
      http()
        .post(`/v1/orgs/${orgId}/channels/${channel.id}/members`)
        .set(as(owner))
        .send({ userId: user.id, role: 'member' });
    await add().expect(201);
    await add().expect(409);

    const event = await pushed;
    const rows = await notesOf(user);
    expect([rows.length, rows[0]?.type, rows[0]?.orgId, event.type, event.payload]).toEqual([
      1,
      'channel.member_added',
      orgId,
      'channel.member_added',
      {
        channelId: channel.id,
        channelName: 'Kỹ thuật',
        role: 'member',
        actorId: owner.id,
        actorName: 'Chủ Org',
      },
    ]);
  });

  it('chuyển chủ kênh: chủ tự chuyển → chỉ chủ mới nhận; Admin org chuyển hộ → cả chủ mới lẫn chủ cũ', async () => {
    const { owner, id: orgId } = await org('Chủ');
    const [host, next1, next2] = [
      await registerUser(app),
      await registerUser(app),
      await registerUser(app),
    ];
    for (const u of [host, next1, next2]) await addMember(db, orgId, u.id);
    const channel = await insertChannel(db, orgId, host.id);
    await addChannelMember(db, channel, orgId, next1.id, 'member');
    await addChannelMember(db, channel, orgId, next2.id, 'member');
    const transfer = (by: TestUser, to: TestUser) =>
      http()
        .post(`/v1/orgs/${orgId}/channels/${channel.id}/ownership-transfer`)
        .set(as(by))
        .send({ newOwnerId: to.id })
        .expect(200);

    await transfer(host, next1); // CO tự chuyển: host → next1
    const afterSelf = [(await notesOf(host)).length, (await notesOf(next1)).length];
    await transfer(owner, next2); // Owner org chuyển hộ: next1 → next2

    expect([afterSelf, (await notesOf(next1)).length, (await notesOf(next2)).length]).toEqual([
      [0, 1],
      2,
      1,
    ]);
    const [toPrevious] = (await notesOf(next1)).filter(
      (n) => (n.payload as { newOwnerId: string }).newOwnerId === next2.id,
    );
    expect(toPrevious?.payload).toMatchObject({ previousOwnerId: next1.id, actorId: owner.id });
  });

  it('yêu cầu vào tổ chức được duyệt → người xin vào nhận `org.join_request_approved`', async () => {
    const { owner, id: orgId } = await org('Duyệt vào');
    await http()
      .patch(`/v1/orgs/${orgId}`)
      .set(as(owner))
      .send({ requireJoinApproval: true })
      .expect(200);
    const invite = (
      await http().post(`/v1/orgs/${orgId}/invites`).set(as(owner)).send({}).expect(201)
    ).body.data.token as string;
    const guest = await registerUser(app);
    const requestId = (await http().post(`/v1/invites/${invite}/accept`).set(as(guest)).expect(200))
      .body.data.requestId as string;
    const pushed = nextEvent<{ type: string }>(await online(guest), 'notification.created');

    await http()
      .post(`/v1/orgs/${orgId}/join-requests/${requestId}/approve`)
      .set(as(owner))
      .expect(200);

    const rows = await notesOf(guest);
    expect([(await pushed).type, rows.map((r) => [r.type, r.payload])]).toEqual([
      'org.join_request_approved',
      [['org.join_request_approved', { orgName: 'Duyệt vào', role: 'member' }]],
    ]);
  });

  it('thao tác thất bại (rollback) → KHÔNG có thông báo "ma"', async () => {
    const { owner, id: orgId } = await org('Rollback');
    const outsider = await registerUser(app); // không thuộc org → thêm vào kênh thất bại
    const channel = await insertChannel(db, orgId, owner.id);

    await http()
      .post(`/v1/orgs/${orgId}/channels/${channel.id}/members`)
      .set(as(owner))
      .send({ userId: outsider.id, role: 'member' })
      .expect(404);

    expect(await notesOf(outsider)).toEqual([]);
  });

  // Đột biến: gọi `publish` BÊN TRONG transaction → lúc emit, connection khác chưa thấy dòng.
  it('đẩy realtime SAU commit: lúc emit, connection khác đã thấy dòng thông báo', async () => {
    const { owner, id: orgId } = await org('Sau commit');
    const user = await registerUser(app);
    await addMember(db, orgId, user.id);
    const channel = await insertChannel(db, orgId, owner.id);
    const publisher = app.get<RealtimePublisher>(REALTIME_PUBLISHER);
    const seen: Array<Promise<boolean>> = [];
    const spy = vi.spyOn(publisher, 'emit').mockImplementation((_rooms, event, payload) => {
      if (event !== 'notification.created') return;
      const id = (payload as { id: string }).id;
      seen.push(
        db
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, id))
          .then((rows) => rows.length === 1),
      );
    });

    await http()
      .post(`/v1/orgs/${orgId}/channels/${channel.id}/members`)
      .set(as(owner))
      .send({ userId: user.id, role: 'member' })
      .expect(201);
    spy.mockRestore();

    expect(await Promise.all(seen)).toEqual([true]);
  });
});
