import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/app.js';
import { bearer, registerUser } from '../../support/factories.js';
import { connectRealtime, portOf } from '../../support/realtime.js';

/** Đường thật: upload qua HTTP → complete → chủ meeting nhận `meeting.status` qua socket (M7 B6). */
describe('Realtime: meeting.status khi upload complete (e2e, Redis + RustFS thật)', () => {
  let app: INestApplication<App>;
  let socket: Socket | undefined;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
  });

  afterAll(async () => {
    socket?.disconnect();
    await app.close();
  });

  it('complete → đúng 1 event `queued` cho chủ; complete lại (200) không phát thêm', async () => {
    const user = await registerUser(app);
    const http = () => request(app.getHttpServer());
    const as = bearer(user.tokens.accessToken);
    const orgId = (await http().post('/v1/orgs').set(as).send({ name: 'ST' }).expect(201)).body.data
      .id as string;
    const conn = await connectRealtime(portOf(app), user.tokens.accessToken);
    socket = conn.socket;
    const events: unknown[] = [];
    socket.on('meeting.status', (p: unknown) => events.push(p));

    const data = randomBytes(1024);
    const uploadId = (
      await http()
        .post(`/v1/orgs/${orgId}/uploads`)
        .set(as)
        .send({
          filename: 'a.m4a',
          mimeType: 'audio/mp4',
          sizeBytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          title: 'Họp',
          recordedAt: new Date().toISOString(),
        })
        .expect(201)
    ).body.data.id as string;
    await http()
      .put(`/v1/orgs/${orgId}/uploads/${uploadId}/parts/1`)
      .set(as)
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    const meetingId = (
      await http().post(`/v1/orgs/${orgId}/uploads/${uploadId}/complete`).set(as).expect(201)
    ).body.data.id as string;
    await http().post(`/v1/orgs/${orgId}/uploads/${uploadId}/complete`).set(as).expect(200);
    await new Promise((r) => setTimeout(r, 500));

    expect([conn.outcome, events]).toEqual([
      'OK',
      [{ meetingId, status: 'queued', failureCode: null }],
    ]);
  });
});
