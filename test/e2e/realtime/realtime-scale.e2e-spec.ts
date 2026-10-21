import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REALTIME_PUBLISHER } from '../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../src/infra/realtime/realtime.types.js';
import { RealtimeGateway } from '../../../src/modules/realtime/realtime.gateway.js';
import { WorkerModule } from '../../../src/worker.module.js';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { connectRealtime, nextEvent, portOf } from '../../support/realtime.js';

/**
 * NHIỀU TIẾN TRÌNH (D6, M7 Q3): hai api instance thật (hai app Nest, cùng Postgres + Redis) và một
 * worker (application context, không HTTP). Event / lệnh ngắt phát ở đâu cũng tới đúng socket, dù
 * socket nằm ở instance khác — nhờ Redis adapter + redis-emitter.
 */
describe('Realtime: 2 api instance + worker (e2e, Redis thật)', () => {
  let apiA: INestApplication<App>;
  let apiB: INestApplication<App>;
  let worker: INestApplicationContext;
  const opened: Socket[] = [];

  const connectTo = async (app: INestApplication, who: TestUser) => {
    const { socket, outcome } = await connectRealtime(portOf(app), who.tokens.accessToken);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    return socket;
  };

  beforeAll(async () => {
    apiA = await createTestApp();
    apiB = await createTestApp();
    await apiA.listen(0);
    await apiB.listen(0);
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await worker.close();
    await apiA.close();
    await apiB.close();
  });

  it('event phát từ instance A tới client đang nối instance B', async () => {
    const user = await registerUser(apiA);
    const onB = await connectTo(apiB, user);
    const got = nextEvent(onB, 'meeting.status');

    apiA
      .get<RealtimePublisher>(REALTIME_PUBLISHER)
      .emit([`user:${user.id}`], 'meeting.status', { meetingId: 'm1', status: 'queued' });

    expect(await got).toEqual({ meetingId: 'm1', status: 'queued' });
  });

  it('worker (không có server Socket.IO) phát → client nhận', async () => {
    const user = await registerUser(apiA);
    const onA = await connectTo(apiA, user);
    const got = nextEvent(onA, 'meeting.status');

    worker
      .get<RealtimePublisher>(REALTIME_PUBLISHER)
      .emit([`user:${user.id}`], 'meeting.status', { meetingId: 'm2', status: 'failed' });

    expect(await got).toEqual({ meetingId: 'm2', status: 'failed' });
  });

  it('logout gọi vào A → socket của phiên đó đang nối B bị ngắt', async () => {
    const user = await registerUser(apiA);
    const onB = await connectTo(apiB, user);
    const ended = new Promise((resolve) => onB.once('disconnect', resolve));

    await request(apiA.getHttpServer())
      .post('/v1/auth/logout')
      .set(bearer(user.tokens.accessToken))
      .expect(204);

    expect(await ended).toBe('io server disconnect');
  });

  it('`fetchSockets` ở A thấy socket nằm ở B (adapter hỏi các instance khác qua Redis)', async () => {
    const user = await registerUser(apiA);
    await connectTo(apiB, user);

    const fromA = await apiA.get(RealtimeGateway).namespace.in(`user:${user.id}`).fetchSockets();

    expect(fromA.map((s) => s.data.user.id)).toEqual([user.id]);
  });

  it('Origin: trang web nằm ngoài REALTIME_CORS_ORIGINS bị từ chối; origin cho phép / không có Origin → vào được', async () => {
    const user = await registerUser(apiA);
    const port = portOf(apiA);
    const tryWith = async (headers?: Record<string, string>) => {
      const r = await connectRealtime(port, user.tokens.accessToken, headers);
      opened.push(r.socket);
      return r.outcome === 'OK' ? 'OK' : 'bị từ chối';
    };

    expect([
      await tryWith({ origin: 'https://evil.example' }),
      await tryWith({ origin: 'http://app.meetnote.test' }),
      await tryWith(),
    ]).toEqual(['bị từ chối', 'OK', 'OK']);
  });
});
