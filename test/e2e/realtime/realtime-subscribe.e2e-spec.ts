import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { REALTIME_PUBLISHER } from '../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../src/infra/realtime/realtime.types.js';
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
import { fixtureDb } from '../../support/db.js';

/** `subscribe { meetingId }` → room `meeting:{id}` CHỈ khi xem được (điều kiện xem của M6b) — M7 B3. */
describe('Realtime: subscribe meeting theo quyền xem (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let port: number;
  let orgId: string;
  const u = {} as Record<
    'owner' | 'orgAdmin' | 'author' | 'chMember' | 'outsider' | 'stranger',
    TestUser
  >;
  const sockets = new Map<TestUser, Socket>();
  let privMeeting: string;
  let orphan: string;

  const ack = (who: TestUser, event: 'subscribe' | 'unsubscribe', body: unknown) =>
    (sockets.get(who) as Socket).timeout(3000).emitWithAck(event, body) as Promise<
      { data: { meetingId: string } } | { error: { code: string } }
    >;
  const outcome = (r: { data?: unknown; error?: { code: string } }) => r.error?.code ?? 'OK';

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = portOf(app);
    db = fixtureDb();
    for (const k of ['owner', 'orgAdmin', 'author', 'chMember', 'outsider', 'stranger'] as const) {
      u[k] = await registerUser(app);
    }
    orgId = (
      await request(app.getHttpServer())
        .post('/v1/orgs')
        .set(bearer(u.owner.tokens.accessToken))
        .send({ name: 'RT' })
        .expect(201)
    ).body.data.id;
    await addMember(db, orgId, u.orgAdmin.id, 'admin');
    for (const k of ['author', 'chMember', 'outsider'] as const)
      await addMember(db, orgId, u[k].id);
    const priv = await insertChannel(db, orgId, u.author.id, { visibility: 'private' });
    await addChannelMember(db, priv, orgId, u.chMember.id);
    privMeeting = (await insertMeeting(db, orgId, u.author.id)).id;
    await shareMeeting(db, orgId, privMeeting, priv.id, u.author.id);
    orphan = (await insertMeeting(db, orgId, null)).id;
    for (const who of Object.values(u)) {
      const { socket, outcome: o } = await connectRealtime(port, who.tokens.accessToken);
      if (o !== 'OK') throw new Error(o);
      sockets.set(who, socket);
    }
  });

  afterAll(async () => {
    for (const s of sockets.values()) s.disconnect();
    await app.close();
  });

  it('ma trận subscribe → ack ok / lỗi đúng mã (giống REST: không xem được = NOT_FOUND)', async () => {
    const cases: Array<[string, TestUser, unknown, string]> = [
      ['chủ meeting', u.author, { meetingId: privMeeting }, 'OK'],
      ['thành viên kênh riêng tư chứa meeting', u.chMember, { meetingId: privMeeting }, 'OK'],
      ['thành viên org ngoài kênh', u.outsider, { meetingId: privMeeting }, 'NOT_FOUND'],
      ['Admin org, kênh riêng tư (D2)', u.orgAdmin, { meetingId: privMeeting }, 'NOT_FOUND'],
      ['Admin org, meeting không chủ (Q2 M6b)', u.orgAdmin, { meetingId: orphan }, 'OK'],
      ['người ngoài org', u.stranger, { meetingId: privMeeting }, 'NOT_FOUND'],
      ['meeting không tồn tại', u.author, { meetingId: randomUUID() }, 'NOT_FOUND'],
      ['meetingId không phải uuid', u.author, { meetingId: 'abc' }, 'VALIDATION_FAILED'],
      ['payload rỗng', u.author, null, 'VALIDATION_FAILED'],
    ];
    const results: Array<[string, string]> = [];
    for (const [label, who, body] of cases)
      results.push([label, outcome(await ack(who, 'subscribe', body))]);
    expect(results).toEqual(cases.map(([label, , , expected]) => [label, expected]));
  });

  it('event vào room meeting chỉ tới socket ĐÃ subscribe; unsubscribe xong thì thôi nhận', async () => {
    const meeting = (await insertMeeting(db, orgId, u.author.id)).id;
    const publisher = app.get<RealtimePublisher>(REALTIME_PUBLISHER);
    const author = sockets.get(u.author) as Socket;
    const owner = sockets.get(u.owner) as Socket; // không subscribe meeting này
    const received: string[] = [];
    owner.on('meeting.status', (p: { meetingId: string }) => {
      if (p.meetingId === meeting) received.push('owner');
    });

    expect(outcome(await ack(u.author, 'subscribe', { meetingId: meeting }))).toBe('OK');
    const first = nextEvent<{ meetingId: string; status: string }>(author, 'meeting.status');
    publisher.emit([`meeting:${meeting}`], 'meeting.status', {
      meetingId: meeting,
      status: 'queued',
    });
    const payload = await first;

    expect(outcome(await ack(u.author, 'unsubscribe', { meetingId: meeting }))).toBe('OK');
    const late: string[] = [];
    author.on('meeting.status', (p: { meetingId: string }) => {
      if (p.meetingId === meeting) late.push('author');
    });
    publisher.emit([`meeting:${meeting}`], 'meeting.status', {
      meetingId: meeting,
      status: 'failed',
    });
    await new Promise((r) => setTimeout(r, 300));

    expect([payload, received, late]).toEqual([{ meetingId: meeting, status: 'queued' }, [], []]);
  });
});
