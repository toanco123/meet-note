import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  meetings,
  meetingShares,
  notifications,
} from '../../../../src/infra/database/schema/index.js';
import { QueueName } from '../../../../src/infra/queue/queue.module.js';
import type { NotificationFanoutJobData } from '../../../../src/infra/queue/queue.types.js';
import { REALTIME_PUBLISHER } from '../../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../../src/infra/realtime/realtime.types.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationFanoutService } from '../../../../src/modules/notifications/services/notification-fanout.service.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/**
 * Logic fan-out mà processor dispatch tới (M10 B5), gọi thẳng — không cần BullMQ. Lô nhỏ (2) để
 * vòng keyset chạy nhiều vòng với vài người nhận.
 */
describe('Fan-out "meeting được chia sẻ" (Postgres thật)', () => {
  let t: TestDb;
  let service: NotificationFanoutService;
  let repo: NotificationsRepository;
  const emitted: string[] = [];
  const realtime: RealtimePublisher = {
    emit: (rooms) => void emitted.push(...rooms),
    endSessions: () => undefined,
    revalidateAccess: () => undefined,
  };

  beforeAll(async () => {
    t = createTestDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationFanoutService,
        NotificationsService,
        NotificationsRepository,
        { provide: DRIZZLE, useValue: t.db },
        { provide: REALTIME_PUBLISHER, useValue: realtime },
        { provide: getQueueToken(QueueName.Default), useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(NotificationFanoutService);
    repo = moduleRef.get(NotificationsRepository);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Kênh: chủ kênh + 4 thành viên + 1 khách; `author` (thành viên) share meeting của mình. */
  async function world() {
    const host = await insertUser(t.db);
    const org = await insertOrg(t.db, host.id);
    const author = await insertUser(t.db, { displayName: 'An' });
    const members = [await insertUser(t.db), await insertUser(t.db), await insertUser(t.db)];
    const guest = await insertUser(t.db);
    for (const u of [author, ...members, guest]) await addMember(t.db, org.id, u.id);
    const channel = await insertChannel(t.db, org.id, host.id, { name: 'Sản phẩm' });
    await addChannelMember(t.db, channel, org.id, author.id, 'member');
    for (const u of members) await addChannelMember(t.db, channel, org.id, u.id, 'member');
    await addChannelMember(t.db, channel, org.id, guest.id, 'guest');
    const meeting = await insertMeeting(t.db, org.id, author.id, { title: 'Họp quý' });
    await shareMeeting(t.db, org.id, meeting.id, channel.id, author.id);
    const job: NotificationFanoutJobData = {
      type: 'meeting.shared',
      meetingId: meeting.id,
      channelId: channel.id,
      requestId: null,
    };
    const recipients = [host.id, ...members.map((u) => u.id)].sort();
    return { org, author, guest, channel, meeting, job, recipients };
  }
  const rowsOf = (meetingId: string) =>
    t.db
      .select()
      .from(notifications)
      .then((rows) =>
        rows.filter((r) => (r.payload as { meetingId?: string }).meetingId === meetingId),
      );

  it('thành viên kênh nhận đúng 1 lần (trừ người share, khách), payload id + tên; chạy lại → 0, không đẩy lại', async () => {
    const w = await world();
    emitted.length = 0;

    const first = await service.run(w.job, 2);
    const emittedFirst = emitted.length;
    const second = await service.run(w.job, 2);
    const rows = await rowsOf(w.meeting.id);

    expect([first, second, emittedFirst, emitted.length]).toEqual([4, 0, 4, 4]);
    expect(rows.map((r) => r.userId).sort()).toEqual(w.recipients);
    expect(rows[0]?.payload).toEqual({
      meetingId: w.meeting.id,
      meetingTitle: 'Họp quý',
      channelId: w.channel.id,
      channelName: 'Sản phẩm',
      actorId: w.author.id,
      actorName: 'An',
    });
    expect(rows.every((r) => r.orgId === w.org.id && r.type === 'meeting.shared')).toBe(true);
  });

  // Đột biến: bỏ `liveShare` khỏi `findLiveShare` / `fanoutRecipients` → đỏ.
  it('kiểm lại lúc chạy: đã gỡ share / meeting đã xoá trước khi job tới lượt → không ai nhận', async () => {
    const unshared = await world();
    await t.db.delete(meetingShares).where(eq(meetingShares.meetingId, unshared.meeting.id));
    const deleted = await world();
    await t.db
      .update(meetings)
      .set({ deletedAt: new Date() })
      .where(eq(meetings.id, deleted.meeting.id));

    expect([await service.run(unshared.job, 2), await service.run(deleted.job, 2)]).toEqual([0, 0]);
    expect([
      (await rowsOf(unshared.meeting.id)).length,
      (await rowsOf(deleted.meeting.id)).length,
    ]).toEqual([0, 0]);
  });

  // Đột biến: bỏ `onConflictDoNothing` → lần chạy lại ném 23505, không bù được phần thiếu.
  it('lỗi giữa chừng (lô 2) → lần chạy lại chỉ bù phần thiếu, mỗi người đúng 1 thông báo', async () => {
    const w = await world();
    const original = repo.insertMany.bind(repo);
    let calls = 0;
    const spy = vi.spyOn(repo, 'insertMany').mockImplementation(async (drafts, executor) => {
      if (++calls === 2) throw new Error('mất kết nối giả lập');
      return original(drafts, executor);
    });

    await expect(service.run(w.job, 2)).rejects.toThrow('mất kết nối giả lập');
    const afterFailure = (await rowsOf(w.meeting.id)).length;
    spy.mockRestore();
    const retried = await service.run(w.job, 2);

    expect([afterFailure, retried]).toEqual([2, 2]);
    expect((await rowsOf(w.meeting.id)).map((r) => r.userId).sort()).toEqual(w.recipients);
  });
});
