import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { type Queue, QueueEvents } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../src/infra/database/database.module.js';
import type { Database } from '../../../src/infra/database/database.types.js';
import { notifications } from '../../../src/infra/database/schema/index.js';
import { JobName } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { connectRealtime, nextEvent, portOf } from '../../support/realtime.js';

/**
 * Đường đi đầy đủ của thông báo nhiều người nhận (M10 B5): share qua HTTP → enqueue SAU commit →
 * processor trong tiến trình worker (Redis thật) → thông báo trong DB + `notification.created`.
 */
describe('Thông báo: fan-out "meeting được chia sẻ" qua worker (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let db: Database;
  let queue: Queue;
  let events: QueueEvents;
  const opened: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    worker = await createTestWorker();
    db = app.get(DRIZZLE);
    queue = app.get(getQueueToken(QueueName.Default));
    events = new QueueEvents(QueueName.Default, {
      connection: { url: process.env.REDIS_URL },
      prefix: process.env.QUEUE_PREFIX,
    });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    for (const s of opened) s.disconnect();
    await events.close();
    await worker.close();
    await app.close();
  });

  const online = async (u: TestUser) => {
    const { socket, outcome } = await connectRealtime(portOf(app), u.tokens.accessToken);
    opened.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    return socket;
  };
  const notesOf = (u: TestUser) =>
    db.select().from(notifications).where(eq(notifications.userId, u.id));

  it('share → thành viên online nhận realtime, khách / người share không có; share lại (200) không tạo job mới', async () => {
    const host = await registerUser(app);
    const orgId = (
      await http().post('/v1/orgs').set(as(host)).send({ name: 'Fan-out' }).expect(201)
    ).body.data.id as string;
    const [author, member, guest] = [
      await registerUser(app, { displayName: 'An' }),
      await registerUser(app),
      await registerUser(app),
    ];
    for (const u of [author, member, guest]) await addMember(db, orgId, u.id);
    const channel = await insertChannel(db, orgId, host.id, { name: 'Sản phẩm' });
    await addChannelMember(db, channel, orgId, author.id, 'member');
    await addChannelMember(db, channel, orgId, member.id, 'member');
    await addChannelMember(db, channel, orgId, guest.id, 'guest');
    const meeting = await insertMeeting(db, orgId, author.id, { title: 'Họp quý' });
    const pushed = nextEvent<{ type: string; payload: Record<string, unknown> }>(
      await online(member),
      'notification.created',
      10_000,
    );
    const share = () =>
      http()
        .post(`/v1/orgs/${orgId}/meetings/${meeting.id}/shares`)
        .set(as(author))
        .send({ channelId: channel.id });

    const sharedAt = (await share().expect(201)).body.data.sharedAt as string;
    const jobId = `${JobName.NotificationFanout}.meeting-shared.${meeting.id}.${channel.id}.${Date.parse(sharedAt)}`;
    const result = await (await queue.getJob(jobId))?.waitUntilFinished(events, 10_000);
    const event = await pushed;
    await share().expect(200);

    expect([result, event.type, event.payload.actorName]).toEqual([
      { created: 2 },
      'meeting.shared',
      'An',
    ]);
    expect([
      (await notesOf(member)).length,
      (await notesOf(host)).length,
      (await notesOf(guest)).length,
      (await notesOf(author)).length,
      (await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).length,
    ]).toEqual([1, 1, 0, 0, 1]);
  });

  // M6 (pipeline) còn hoãn: job M5 đã enqueue không được thành `failed` (jobId cũ sẽ chặn enqueue lại).
  it('`meeting.preprocess` (chưa có pipeline) → cất về `delayed`, không tính lần thử; tên job lạ → `failed` ngay', async () => {
    const parked = await queue.add(
      JobName.MeetingPreprocess,
      { meetingId: randomUUID(), requestId: null },
      { jobId: `${JobName.MeetingPreprocess}.${randomUUID()}.a1`, attempts: 3 },
    );
    const unknown = await queue.add('khong.ton.tai', {}, { attempts: 3 });

    await expect(unknown.waitUntilFinished(events, 10_000)).rejects.toThrow('Job không xác định');
    await vi.waitFor(async () => expect(await parked.getState()).toBe('delayed'), {
      timeout: 10_000,
    });
    const [parkedNow, unknownNow] = [
      await queue.getJob(parked.id!),
      await queue.getJob(unknown.id!),
    ];
    expect([parkedNow?.attemptsMade, unknownNow?.attemptsMade]).toEqual([0, 1]);
  });
});
