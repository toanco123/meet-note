import type { INestApplication } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { notifications } from '../../../src/infra/database/schema/index.js';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { connectRealtime, nextEvent, portOf } from '../../support/realtime.js';

/** Đọc ở một phiên → các phiên khác của CÙNG người nhận `notification.read` (M10 B4). */
describe('Thông báo: đồng bộ "đã đọc" giữa các phiên (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await app.close();
  });

  const online = async (accessToken: string) => {
    const { socket, outcome } = await connectRealtime(portOf(app), accessToken);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    return socket;
  };
  /** Phiên thứ hai của cùng người (như đăng nhập trên thiết bị khác). */
  const secondSession = async (u: TestUser) =>
    (await http().post('/v1/auth/login').send({ email: u.email, password: u.password }).expect(200))
      .body.data.accessToken as string;
  const seed = async (userId: string, orgId: string | null = null) => {
    const [row] = await db
      .insert(notifications)
      .values({ userId, orgId, type: 'channel.member_added', payload: { channelName: 'K' } })
      .returning({ id: notifications.id });
    return row?.id as string;
  };

  it('đọc một thông báo ở phiên A → phiên B nhận `{ ids }`; người khác không nhận', async () => {
    const [me, other] = [await registerUser(app), await registerUser(app)];
    const phoneToken = await secondSession(me);
    const [phone, otherSocket] = [await online(phoneToken), await online(other.tokens.accessToken)];
    const id = await seed(me.id);
    const strayToOther: unknown[] = [];
    otherSocket.on('notification.read', (e: unknown) => strayToOther.push(e));
    const pushed = nextEvent(phone, 'notification.read');

    await http()
      .post(`/v1/notifications/${id}/read`)
      .set(bearer(me.tokens.accessToken))
      .expect(204);

    expect(await pushed).toEqual({ ids: [id] });
    // Cùng một publisher + một kênh Redis → nếu phát nhầm tới `other`, event đó đã tới TRƯỚC event
    // của chính `other` (204 chưa có nghĩa là event đã tới socket — phải chờ event của `other`).
    const otherId = await seed(other.id);
    const own = nextEvent(otherSocket, 'notification.read');
    await http()
      .post(`/v1/notifications/${otherId}/read`)
      .set(bearer(other.tokens.accessToken))
      .expect(204);
    await own;
    expect(strayToOther).toEqual([{ ids: [otherId] }]);
  });

  // Thiếu sự kiện thì không chờ được "không có gì"; thay vào đó dựa vào THỨ TỰ: các event từ cùng
  // tiến trình tới cùng socket đi qua một kênh Redis nên giữ thứ tự — event KẾ TIẾP phiên B nhận
  // phải là của thao tác sau, không phải của thao tác không đổi gì / bị 404 trước đó.
  it('đọc hết → `{ all, orgId }`; đọc hết khi không còn gì / đọc của người khác (404) → không phát', async () => {
    const [me, other] = [await registerUser(app), await registerUser(app)];
    const orgId = (
      await http()
        .post('/v1/orgs')
        .set(bearer(me.tokens.accessToken))
        .send({ name: 'Đồng bộ' })
        .expect(201)
    ).body.data.id as string;
    const phone = await online(await secondSession(me));
    await seed(me.id, orgId);
    const as = bearer(me.tokens.accessToken);

    const allInOrg = nextEvent(phone, 'notification.read');
    await http().post('/v1/notifications/read-all').query({ orgId }).set(as).expect(204);
    const first = await allInOrg;

    const next = nextEvent(phone, 'notification.read');
    await http().post('/v1/notifications/read-all').set(as).expect(204); // không còn gì chưa đọc
    await http()
      .post(`/v1/notifications/${await seed(other.id)}/read`)
      .set(as)
      .expect(404);
    const id = await seed(me.id);
    await http().post(`/v1/notifications/${id}/read`).set(as).expect(204);

    expect([first, await next]).toEqual([{ all: true, orgId }, { ids: [id] }]);
  });
});
