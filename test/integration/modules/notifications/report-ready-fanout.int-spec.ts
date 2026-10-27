import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  channels,
  notifications,
  weeklyReports,
  weeklyReportVersions,
} from '../../../../src/infra/database/schema/index.js';
import { QueueName } from '../../../../src/infra/queue/queue.module.js';
import type { ReportReadyFanoutJobData } from '../../../../src/infra/queue/queue.types.js';
import { REALTIME_PUBLISHER } from '../../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../../src/infra/realtime/realtime.types.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationFanoutService } from '../../../../src/modules/notifications/services/notification-fanout.service.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import {
  addChannelMember,
  addMember,
  insertChannel,
  insertOrg,
  insertUser,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

/** Fan-out "báo cáo tuần xong" (M9 B7), gọi thẳng `run` — lô nhỏ (2) để keyset chạy nhiều vòng. */
describe('Fan-out "report.ready" (Postgres thật)', () => {
  let t: TestDb;
  let service: NotificationFanoutService;
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
  });

  afterAll(async () => {
    await t.close();
  });

  /** Kênh: chủ kênh + admin + 3 thành viên + 1 khách, báo cáo tuần có 1 phiên bản. */
  async function world() {
    const host = await insertUser(t.db);
    const org = await insertOrg(t.db, host.id);
    const admin = await insertUser(t.db);
    const members = [await insertUser(t.db), await insertUser(t.db), await insertUser(t.db)];
    const guest = await insertUser(t.db);
    for (const u of [admin, ...members, guest]) await addMember(t.db, org.id, u.id);
    const channel = await insertChannel(t.db, org.id, host.id, { name: 'Kinh doanh' });
    await addChannelMember(t.db, channel, org.id, admin.id, 'admin');
    for (const u of members) await addChannelMember(t.db, channel, org.id, u.id, 'member');
    await addChannelMember(t.db, channel, org.id, guest.id, 'guest');
    const [report] = await t.db
      .insert(weeklyReports)
      .values({
        channelId: channel.id,
        orgId: org.id,
        weekStart: '2026-10-05',
        status: 'completed',
        currentVersion: 1,
      })
      .returning();
    await t.db.insert(weeklyReportVersions).values({
      reportId: report!.id,
      orgId: org.id,
      version: 1,
      trigger: 'scheduled',
      content: {},
      meetingIds: [],
      model: 'fake',
      promptVersion: 'v1',
      inputTokens: 0,
      outputTokens: 0,
    });
    const job: ReportReadyFanoutJobData = {
      type: 'report.ready',
      reportId: report!.id,
      version: 1,
      requestId: null,
    };
    const recipients = [host.id, admin.id, ...members.map((u) => u.id)].sort();
    return { org, channel, guest, report: report!, job, recipients };
  }
  const rowsOf = (reportId: string) =>
    t.db
      .select()
      .from(notifications)
      .then((rows) =>
        rows.filter((r) => (r.payload as { reportId?: string }).reportId === reportId),
      );

  // Đột biến: bỏ `ne(role, 'guest')` → Khách cũng nhận (04: Khách KHÔNG nhận thông báo báo cáo tuần).
  it('thành viên kênh TRỪ Khách nhận đúng 1 lần; chạy lại → 0, không đẩy lại; payload id + tên + tuần + phiên bản', async () => {
    const w = await world();
    emitted.length = 0;
    const first = await service.run(w.job, 2);
    const emittedFirst = emitted.length;
    const second = await service.run(w.job, 2);
    const rows = await rowsOf(w.report.id);

    expect([first, second, emittedFirst, emitted.length]).toEqual([5, 0, 5, 5]);
    expect(rows.map((r) => r.userId).sort()).toEqual(w.recipients);
    expect(rows.some((r) => r.userId === w.guest.id)).toBe(false);
    expect(rows[0]?.payload).toEqual({
      reportId: w.report.id,
      channelId: w.channel.id,
      channelName: 'Kinh doanh',
      weekStart: '2026-10-05',
      version: 1,
    });
    expect(rows.every((r) => r.orgId === w.org.id && r.type === 'report.ready')).toBe(true);
    expect(new Set(rows.map((r) => r.dedupeKey))).toEqual(
      new Set([`report-ready.${w.report.id}.v1`]),
    );
  });

  it('phiên bản MỚI (tạo lại) là thông báo mới; phiên bản không tồn tại → 0', async () => {
    const w = await world();
    await service.run(w.job, 2);
    await t.db.insert(weeklyReportVersions).values({
      reportId: w.report.id,
      orgId: w.org.id,
      version: 2,
      trigger: 'manual',
      content: {},
      meetingIds: [],
      model: 'fake',
      promptVersion: 'v1',
      inputTokens: 0,
      outputTokens: 0,
    });
    const v2 = await service.run({ ...w.job, version: 2 }, 2);
    const ghost = await service.run({ ...w.job, version: 9 }, 2);
    expect([v2, ghost, (await rowsOf(w.report.id)).length]).toEqual([5, 0, 10]);
  });

  // Đột biến: bỏ `isNull(channels.deletedAt)` ở `findLiveReportVersion` → kênh đã xoá vẫn gửi.
  it('kênh đã xoá mềm trước khi job tới lượt → không ai nhận', async () => {
    const deleted = await world();
    await t.db
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, deleted.channel.id));
    expect([await service.run(deleted.job, 2), (await rowsOf(deleted.report.id)).length]).toEqual([
      0, 0,
    ]);
  });
});
