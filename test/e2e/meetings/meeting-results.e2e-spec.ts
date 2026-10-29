import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  auditLogs,
  meetings,
  meetingSummaries,
  notifications,
  transcriptSegments,
} from '../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../src/infra/llm/fake.summarizer.js';
import { JobName } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  shareMeeting,
} from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { generateAudio, uploadAudioMeeting } from '../../support/pipeline.js';

/** API đọc kết quả + chạy lại (M6 B7): quyền theo 04 §3 (xem) và như PATCH (chạy lại). */
describe('Meeting: transcript / tóm tắt / chạy lại (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let queue: Queue;
  let audio: Buffer;
  const workers: INestApplicationContext[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    queue = app.get<Queue>(getQueueToken(QueueName.Default));
    audio = await generateAudio();
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Org: chủ meeting, thành viên thường (thấy meeting qua kênh CÔNG KHAI nó được share vào),
   * `outsider` (dùng với meeting KHÔNG share → 404), Admin org.
   */
  async function world(status: 'completed' | 'failed' = 'completed', ownerless = false) {
    const [orgOwner, author, viewer, outsider, admin] = await Promise.all(
      Array.from({ length: 5 }, () => registerUser(app)),
    );
    const orgId = (
      await http().post('/v1/orgs').set(as(orgOwner!)).send({ name: 'Kết quả' }).expect(201)
    ).body.data.id as string;
    for (const u of [author!, viewer!, outsider!]) await addMember(db, orgId, u.id);
    await addMember(db, orgId, admin!.id, 'admin');
    const meeting = await insertMeeting(db, orgId, ownerless ? null : author!.id, {
      status,
      ...(status === 'failed' && { failureCode: 'SUMMARIZE_FAILED', failureMessage: 'x' }),
    });
    const channel = await insertChannel(db, orgId, orgOwner!.id, { visibility: 'public' });
    await shareMeeting(db, orgId, meeting.id, channel.id, ownerless ? null : author!.id);
    return {
      orgId,
      meetingId: meeting.id,
      author: author!,
      viewer: viewer!,
      outsider: outsider!,
      admin: admin!,
    };
  }
  const url = (orgId: string, meetingId: string, suffix: string) =>
    `/v1/orgs/${orgId}/meetings/${meetingId}${suffix}`;

  it('transcript: theo seq, phân trang cursor (cursor trỏ seq 0 không bị coi là "không có"); người xem được qua kênh đọc được', async () => {
    const w = await world();
    await db.insert(transcriptSegments).values(
      Array.from({ length: 7 }, (_, seq) => ({
        meetingId: w.meetingId,
        orgId: w.orgId,
        seq,
        startMs: seq * 1_000,
        endMs: seq * 1_000 + 900,
        text: `Câu ${seq}`,
      })),
    );
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await http()
        .get(url(w.orgId, w.meetingId, '/transcript'))
        .query(cursor ? { limit: 1, cursor } : { limit: 1 })
        .set(as(w.viewer))
        .expect(200);
      pages.push((res.body.data as Array<{ seq: number }>).map((s) => s.seq));
      cursor = res.body.meta.nextCursor;
    } while (cursor && pages.length < 10);
    const bad = await http()
      .get(url(w.orgId, w.meetingId, '/transcript'))
      .query({ cursor: 'rác' })
      .set(as(w.viewer));
    expect([pages, bad.status]).toEqual([[[0], [1], [2], [3], [4], [5], [6]], 400]);
  });

  it('summary: completed → nội dung; chưa xong → 409 MEETING_NOT_COMPLETED', async () => {
    const done = await world();
    await db.insert(meetingSummaries).values({
      meetingId: done.meetingId,
      orgId: done.orgId,
      content: {
        overview: 'Chốt kế hoạch',
        keyPoints: ['a'],
        decisions: [],
        actionItems: [{ owner: 'Bình', task: 't', due: null }],
      },
      model: 'claude-opus-5-5',
      promptVersion: 'v1',
      inputTokens: 10,
      outputTokens: 5,
    });
    const pending = await world('failed');
    const ok = await http()
      .get(url(done.orgId, done.meetingId, '/summary'))
      .set(as(done.author))
      .expect(200);
    const notYet = await http()
      .get(url(pending.orgId, pending.meetingId, '/summary'))
      .set(as(pending.author));
    expect(ok.body.data).toMatchObject({
      overview: 'Chốt kế hoạch',
      // Tóm tắt `v1` đã lưu (ở trên) không có `dueDate` → API trả null, không bỏ trống field (M12).
      actionItems: [{ owner: 'Bình', task: 't', due: null, dueDate: null }],
      model: 'claude-opus-5-5',
    });
    expect([notYet.status, notYet.body.error.code]).toEqual([409, 'MEETING_NOT_COMPLETED']);
  });

  it('ma trận: chủ / người xem được / người KHÔNG xem được / Admin org (meeting có chủ)', async () => {
    const w = await world('failed');
    const status = async (u: TestUser, method: 'get' | 'post', suffix: string) =>
      (
        await http()
          [method](url(w.orgId, w.meetingId, suffix))
          .set(as(u))
      ).status;
    // Meeting của `w` share vào kênh công khai → mọi thành viên thấy; meeting KHÔNG share thì chỉ chủ:
    const hidden = await insertMeeting(db, w.orgId, w.author.id, { status: 'failed' });
    const hiddenStatus = (
      await http()
        .get(url(w.orgId, hidden.id, '/transcript'))
        .set(as(w.outsider))
    ).status;
    expect([
      await status(w.viewer, 'get', '/transcript'),
      await status(w.viewer, 'post', '/retry'), // xem được nhưng không quản lý
      await status(w.admin, 'post', '/retry'), // meeting CÓ chủ → Admin không quản lý
      hiddenStatus,
    ]).toEqual([200, 403, 403, 404]);
  });

  it('chạy lại: failed → 202, attempt 2, queued, job `…a2`; đang chạy → 409; Admin chạy lại meeting KHÔNG chủ → audit', async () => {
    const w = await world('failed');
    const res = await http()
      .post(url(w.orgId, w.meetingId, '/retry'))
      .set(as(w.author))
      .expect(202);
    const again = await http()
      .post(url(w.orgId, w.meetingId, '/retry'))
      .set(as(w.author));
    const job = await queue.getJob(`${JobName.MeetingPreprocess}.${w.meetingId}.a2`);
    const ownerless = await world('failed', true);
    await http()
      .post(url(ownerless.orgId, ownerless.meetingId, '/retry'))
      .set(as(ownerless.admin))
      .expect(202);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.targetId, ownerless.meetingId), eq(auditLogs.action, 'meeting.retried')),
      );

    expect([res.body.data.status, res.body.data.attempt, res.body.data.failureCode]).toEqual([
      'queued',
      2,
      null,
    ]);
    expect([again.status, again.body.error.code, job?.data]).toEqual([
      409,
      'MEETING_NOT_FAILED',
      { meetingId: w.meetingId, attempt: 2, requestId: expect.any(String) },
    ]);
    expect(audit).toHaveLength(1);
  });

  // Đột biến: bỏ kiểm `status = 'failed'` sau khi khoá → hai lần cùng tăng attempt (3) và 2 job.
  it('RACE: 2 lần chạy lại SONG SONG → đúng một 202, attempt chỉ tăng 1, đúng 1 job', async () => {
    const w = await world('failed');
    const results = await Promise.all([
      http()
        .post(url(w.orgId, w.meetingId, '/retry'))
        .set(as(w.author)),
      http()
        .post(url(w.orgId, w.meetingId, '/retry'))
        .set(as(w.author)),
    ]);
    const [row] = await db.select().from(meetings).where(eq(meetings.id, w.meetingId));
    const jobs = await Promise.all(
      [2, 3].map((a) => queue.getJob(`${JobName.MeetingPreprocess}.${w.meetingId}.a${a}`)),
    );
    expect([
      results.map((r) => r.status).sort((a, b) => a - b),
      row?.attempt,
      jobs.map(Boolean),
    ]).toEqual([[202, 409], 2, [true, false]]);
  });

  it('vòng thật: lỗi ở attempt 1 → chạy lại → completed ở attempt 2; thông báo tách theo attempt', async () => {
    const owner = await registerUser(app);
    const orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Vòng' }).expect(201))
      .body.data.id as string;
    workers.push(
      await createTestWorker({ summarizer: new FakeSummarizer({ permanentFailure: true }) }),
    );
    const meetingId = await uploadAudioMeeting(app, owner, orgId, audio);
    const statusOf = async () =>
      (await db.select().from(meetings).where(eq(meetings.id, meetingId)))[0]?.status;
    await vi.waitFor(async () => expect(await statusOf()).toBe('failed'), {
      timeout: 20_000,
      interval: 100,
    });
    await workers.splice(0)[0]!.close();

    workers.push(await createTestWorker());
    await http().post(`/v1/orgs/${orgId}/meetings/${meetingId}/retry`).set(as(owner)).expect(202);
    await vi.waitFor(async () => expect(await statusOf()).toBe('completed'), {
      timeout: 20_000,
      interval: 100,
    });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(notes.map((n) => n.dedupeKey ?? '').sort((a, b) => a.localeCompare(b))).toEqual([
      `meeting-completed.${meetingId}.a2`,
      `meeting-failed.${meetingId}.a1`,
    ]);
  });
});
