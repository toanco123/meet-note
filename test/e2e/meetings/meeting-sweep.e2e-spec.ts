import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { meetings } from '../../../src/infra/database/schema/index.js';
import { JobName, meetingJobId } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import type { SpeechToText, TranscribeOptions } from '../../../src/infra/speech/speech.types.js';
import { MeetingSweepService } from '../../../src/modules/meetings/services/meeting-sweep.service.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { insertMeeting, insertOrg, insertUser } from '../../support/db-factories.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { generateAudio, uploadAudioMeeting } from '../../support/pipeline.js';

/** Whisper "đang chạy" một bản ghi dài: chiếm slot DUY NHẤT của queue `transcription` tới khi huỷ. */
class HangingSpeech implements SpeechToText {
  readonly started = Promise.withResolvers<void>();
  transcribe(_wav: string, options: TranscribeOptions): Promise<never> {
    this.started.resolve();
    return new Promise((_resolve, reject) =>
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason as Error)),
    );
  }
}

/**
 * Quét meeting kẹt (M6 B8): tiến trình worker THẬT, BullMQ / Postgres thật. Gọi thẳng
 * `MeetingSweepService.sweep()` thay vì chờ lịch 5 phút (lịch có test riêng ở platform).
 */
describe('Quét meeting kẹt (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let defaultQueue: Queue;
  let transcriptionQueue: Queue;
  let audio: Buffer;
  const workers: INestApplicationContext[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    db = fixtureDb();
    defaultQueue = app.get<Queue>(getQueueToken(QueueName.Default));
    transcriptionQueue = app.get<Queue>(getQueueToken(QueueName.Transcription));
    audio = await generateAudio();
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    await app.close();
  });

  const startWorker = async (overrides: Parameters<typeof createTestWorker>[0] = {}) => {
    const worker = await createTestWorker(overrides);
    workers.push(worker);
    return worker;
  };
  async function uploadMeeting(): Promise<string> {
    const owner = await registerUser(app);
    const orgId = (await http().post('/v1/orgs').set(as(owner)).send({ name: 'Quét' }).expect(201))
      .body.data.id as string;
    return uploadAudioMeeting(app, owner, orgId, audio);
  }
  const meetingRow = async (id: string) =>
    (await db.select().from(meetings).where(eq(meetings.id, id)))[0]!;
  const waitStatus = (id: string, status: string) =>
    vi.waitFor(async () => expect((await meetingRow(id)).status).toBe(status), {
      timeout: 20_000,
      interval: 100,
    });
  /** "Lâu không đổi": lùi `updated_at` (SQL thô — `$onUpdate` của Drizzle sẽ ghi đè thành now()). */
  const backdate = (id: string) =>
    db.execute(sql`update meetings set updated_at = now() - interval '1 hour' where id = ${id}`);
  const jobIdsOf = async (queue: Queue, meetingId: string) =>
    (await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']))
      .map((j) => j.id!)
      .filter((id) => id.includes(meetingId))
      .sort((a, b) => a.localeCompare(b));

  // Đột biến: `requeue` dùng lại jobId thường `…a1` → `add()` bị nuốt (job a1 đã completed còn được
  // giữ) → meeting kẹt mãi, test hết giờ.
  it('worker chết cứng giữa preprocess: job chạy lại "bỏ qua" (lease còn) → hết lease → quét → completed', async () => {
    const meetingId = await uploadMeeting();
    // Như một worker đã nhận việc rồi bị SIGKILL: chặng `preprocessing`, lease của token lạ còn 1 giờ.
    await db
      .update(meetings)
      .set({
        status: 'preprocessing',
        stageToken: sql`gen_random_uuid()`,
        stageLeaseUntil: sql`now() + interval '1 hour'`,
      })
      .where(eq(meetings.id, meetingId));
    const a1 = meetingJobId(JobName.MeetingPreprocess, meetingId, 1);
    // BullMQ chạy lại job (stalled) → `claim` 0 dòng → job `completed` mà meeting không tiến.
    await startWorker();
    await vi.waitFor(async () => expect(await defaultQueue.getJobState(a1)).toBe('completed'), {
      timeout: 20_000,
      interval: 100,
    });
    await workers.splice(0)[0]!.close();

    // Lease hết hạn, meeting lâu không đổi → quét 2 LẦN liền. Lần 2 hoặc không thấy meeting (job đã
    // nhận việc → lease mới), hoặc thấy nguyên trạng thái kẹt → cùng `.r<version>` → BullMQ bỏ qua.
    await db.execute(
      sql`update meetings set stage_lease_until = now() - interval '1 minute', updated_at = now() - interval '1 hour' where id = ${meetingId}`,
    );
    const sweeper = (await startWorker()).get(MeetingSweepService);
    const [first, second] = [await sweeper.sweep(), await sweeper.sweep()];
    await waitStatus(meetingId, 'completed');

    const requeueJobs = (await jobIdsOf(defaultQueue, meetingId)).filter((id) =>
      id.startsWith(`${a1}.r`),
    );
    expect([first.requeued, second.skipped, requeueJobs.length]).toEqual([[meetingId], [], 1]);
  });

  it('meeting `queued` mà job không tồn tại (enqueue sau commit lỗi) → quét → completed', async () => {
    const meetingId = await uploadMeeting();
    await (await defaultQueue.getJob(
      meetingJobId(JobName.MeetingPreprocess, meetingId, 1),
    ))!.remove();
    await backdate(meetingId);
    const result = await (await startWorker()).get(MeetingSweepService).sweep();
    await waitStatus(meetingId, 'completed');
    expect(result.requeued).toEqual([meetingId]);
  });

  // Đột biến (mỗi cái đỏ riêng): bỏ `hasLiveJob` → B bị requeue; bỏ điều kiện lease → A lọt vào
  // kết quả; bỏ điều kiện `updated_at` → C bị requeue.
  it('không đụng: B XẾP HÀNG sau bản ghi dài (job waiting), A đang chạy (lease), C vừa đổi', async () => {
    const hanging = new HangingSpeech();
    const worker = await startWorker({ speech: hanging });
    const meetingA = await uploadMeeting();
    await hanging.started.promise;
    const meetingB = await uploadMeeting();
    await waitStatus(meetingB, 'transcribing'); // preprocess xong, job transcribe chờ sau A
    const bJob = meetingJobId(JobName.MeetingTranscribe, meetingB, 1);
    expect(await transcriptionQueue.getJobState(bJob)).toBe('waiting');

    const owner = await insertUser(db);
    const org = await insertOrg(db, owner.id);
    await insertMeeting(db, org.id, owner.id, { status: 'summarizing' });
    await Promise.all([backdate(meetingA), backdate(meetingB)]);

    const result = await worker.get(MeetingSweepService).sweep();
    // C (`summarizing`, không job, KHÔNG lease) chỉ được để yên vì vừa đổi < 10 phút.
    expect(result).toEqual({ requeued: [], skipped: [meetingB] });
  });

  // Đột biến: bỏ keyset `after` → lô 1 dòng lặp lại đúng dòng đầu (kết quả trùng, thiếu 2 dòng sau).
  it('nhiều meeting kẹt, lô 1 dòng → keyset đi hết, mỗi meeting đúng một lần', async () => {
    const owner = await insertUser(db);
    const org = await insertOrg(db, owner.id);
    const stuck = await Promise.all(
      [3, 2, 1].map((hours) =>
        insertMeeting(db, org.id, owner.id, {
          status: 'summarizing',
          updatedAt: new Date(Date.now() - hours * 3_600_000),
        }),
      ),
    );
    const sweeper = (await startWorker()).get(MeetingSweepService);
    const result = await sweeper.sweep({ batchSize: 1 });
    // Thứ tự theo `updated_at` cũ nhất trước (3 giờ → 1 giờ); meeting của test trước có thể đã
    // completed nên chỉ lọc meeting của test này.
    const ours = new Set(stuck.map((m) => m.id));
    expect(result.requeued.filter((id) => ours.has(id))).toEqual(stuck.map((m) => m.id));
  });
});
