import type { INestApplication } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { RealtimeGateway } from '../../../src/modules/realtime/realtime.gateway.js';
import { createTestApp } from '../../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { connectRealtime, nextEvent, portOf } from '../../support/realtime.js';

/**
 * MẤT QUYỀN XEM → RỜI ROOM NGAY (M7 Q2, B5). Mỗi loại thay đổi đi qua REST thật (đúng điểm phát
 * "kiểm lại" sau commit); người mất quyền nhận `meeting.access_revoked` và không còn trong room,
 * người còn quyền ở lại.
 */
describe('Realtime: mất quyền xem meeting là rời room (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let port: number;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = portOf(app);
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await app.close();
  });

  /** Org mới: owner (Owner org), admin (Admin org), host (chủ 2 kênh), viewer (ở kênh riêng tư), outsider. */
  async function world() {
    const [owner, admin, host, viewer, outsider] = (await Promise.all(
      Array.from({ length: 5 }, () => registerUser(app)),
    )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
    const orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(owner.tokens.accessToken))
        .send({ name: 'RV' })
        .expect(201)
    ).body.data.id as string;
    await addMember(db, orgId, admin.id, 'admin');
    for (const u of [host, viewer, outsider]) await addMember(db, orgId, u.id);
    const priv = (await insertChannel(db, orgId, host.id, { visibility: 'private' })).id;
    const pub = (await insertChannel(db, orgId, host.id, { visibility: 'public' })).id;
    await addChannelMember(db, { id: priv }, orgId, viewer.id);
    /** Meeting của host share vào `channels`. */
    const meetingIn = async (...channels: string[]) => {
      const id = (await insertMeeting(db, orgId, host.id)).id;
      for (const c of channels) await shareMeeting(db, orgId, id, c, host.id);
      return id;
    };
    const as = (u: TestUser) => bearer(u.tokens.accessToken);
    return { owner, admin, host, viewer, outsider, orgId, priv, pub, meetingIn, as };
  }

  /** Kết nối + subscribe; trả socket để chờ `meeting.access_revoked`. */
  async function subscribed(user: TestUser, meetingId: string): Promise<Socket> {
    const { socket, outcome } = await connectRealtime(port, user.tokens.accessToken);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    const ack = (await socket.timeout(3000).emitWithAck('subscribe', { meetingId })) as {
      error?: { code: string };
    };
    if (ack.error) throw new Error(`subscribe thất bại: ${ack.error.code}`);
    return socket;
  }

  /** Socket nào (theo user id) còn trong room meeting — nhìn từ server. */
  const inRoom = async (meetingId: string) =>
    (await app.get(RealtimeGateway).namespace.in(`meeting:${meetingId}`).fetchSockets())
      .map((s) => s.data.user.id)
      .sort();
  const revoked = (socket: Socket) =>
    nextEvent<{ meetingId: string }>(socket, 'meeting.access_revoked');

  it('gỡ share khỏi kênh riêng tư → thành viên kênh rời room; chủ meeting ở lại', async () => {
    const w = await world();
    const m = await w.meetingIn(w.priv);
    const viewer = await subscribed(w.viewer, m);
    await subscribed(w.host, m);
    const lost = revoked(viewer);

    await http()
      .delete(`/v1/orgs/${w.orgId}/meetings/${m}/shares/${w.priv}`)
      .set(w.as(w.host))
      .expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, [w.host.id]]);
  });

  it('xoá meeting → mọi subscriber rời room (kể cả chủ)', async () => {
    const w = await world();
    const m = await w.meetingIn(w.priv);
    const viewer = await subscribed(w.viewer, m);
    const host = await subscribed(w.host, m);
    const lost = Promise.all([revoked(viewer), revoked(host)]);

    await http().delete(`/v1/orgs/${w.orgId}/meetings/${m}`).set(w.as(w.host)).expect(204);

    expect([(await lost).length, await inRoom(m)]).toEqual([2, []]);
  });

  it('bị gỡ khỏi kênh riêng tư → rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.priv);
    const lost = revoked(await subscribed(w.viewer, m));

    await http()
      .delete(`/v1/orgs/${w.orgId}/channels/${w.priv}/members/${w.viewer.id}`)
      .set(w.as(w.host))
      .expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('tự rời kênh riêng tư → rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.priv);
    const lost = revoked(await subscribed(w.viewer, m));

    await http()
      .post(`/v1/orgs/${w.orgId}/channels/${w.priv}/leave`)
      .set(w.as(w.viewer))
      .expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('kênh công khai → riêng tư: người ngoài kênh rời room, thành viên kênh ở lại', async () => {
    const w = await world();
    const m = await w.meetingIn(w.pub);
    const lost = revoked(await subscribed(w.outsider, m));
    await subscribed(w.host, m);

    await http()
      .patch(`/v1/orgs/${w.orgId}/channels/${w.pub}`)
      .set(w.as(w.host))
      .send({ visibility: 'private' })
      .expect(200);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, [w.host.id]]);
  });

  it('xoá kênh → người chỉ thấy meeting qua kênh đó rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.priv);
    const lost = revoked(await subscribed(w.viewer, m));

    await http().delete(`/v1/orgs/${w.orgId}/channels/${w.priv}`).set(w.as(w.host)).expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('bị gỡ khỏi tổ chức → rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.pub);
    const lost = revoked(await subscribed(w.outsider, m));

    await http()
      .delete(`/v1/orgs/${w.orgId}/members/${w.outsider.id}`)
      .set(w.as(w.owner))
      .expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('tự rời tổ chức → rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.pub);
    const lost = revoked(await subscribed(w.outsider, m));

    await http().post(`/v1/orgs/${w.orgId}/leave`).set(w.as(w.outsider)).expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('Admin org bị hạ xuống member → mất quyền với meeting KHÔNG CHỦ → rời room', async () => {
    const w = await world();
    const orphan = (await insertMeeting(db, w.orgId, null)).id;
    const lost = revoked(await subscribed(w.admin, orphan));

    await http()
      .patch(`/v1/orgs/${w.orgId}/members/${w.admin.id}`)
      .set(w.as(w.owner))
      .send({ role: 'member' })
      .expect(200);

    expect([await lost, await inRoom(orphan)]).toEqual([{ meetingId: orphan }, []]);
  });

  it('xoá tổ chức → mọi subscriber meeting của tổ chức rời room', async () => {
    const w = await world();
    const m = await w.meetingIn(w.pub);
    const lost = revoked(await subscribed(w.outsider, m));

    await http().delete(`/v1/orgs/${w.orgId}`).set(w.as(w.owner)).expect(204);

    expect([await lost, await inRoom(m)]).toEqual([{ meetingId: m }, []]);
  });

  it('subscribe vào meeting của tổ chức ĐÃ XOÁ → NOT_FOUND (dùng đúng membership của guard REST)', async () => {
    const w = await world();
    const m = await w.meetingIn(w.pub);
    await http().delete(`/v1/orgs/${w.orgId}`).set(w.as(w.owner)).expect(204);
    const { socket } = await connectRealtime(port, w.outsider.tokens.accessToken);
    opened.push(socket);

    const ack = (await socket.timeout(3000).emitWithAck('subscribe', { meetingId: m })) as {
      error?: { code: string };
    };

    expect(ack.error?.code).toBe('NOT_FOUND');
  });
});
