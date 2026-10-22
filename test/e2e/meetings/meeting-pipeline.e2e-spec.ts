import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import {
  meetings,
  meetingSummaries,
  transcriptSegments,
} from '../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../src/infra/llm/fake.summarizer.js';
import { JobName } from '../../../src/infra/queue/jobs.js';
import { QueueName } from '../../../src/infra/queue/queue.module.js';
import { FakeSpeechToText } from '../../../src/infra/speech/fake.speech-to-text.js';
import type { SpeechToText, TranscribeOptions } from '../../../src/infra/speech/speech.types.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { generateAudio, uploadAudioMeeting } from '../../support/pipeline.js';

/** Bộ nhận dạng "treo" tới khi bị huỷ — giả lập whisper đang chạy dài lúc worker tắt. */
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
 * Pipeline M6 qua BullMQ THẬT (B5): upload HTTP → complete → processor trong tiến trình worker →
 * Postgres / RustFS / ffmpeg thật, speech / LLM giả. Backoff dài (30–60 s) → test `promote()` job
 * đang `delayed` thay vì chờ.
 */
describe('Pipeline meeting qua BullMQ (e2e)', () => {
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

  // Mọi worker trong file dùng CHUNG queue: worker của test trước còn chạy sẽ "ăn" job của test sau
  // (lần chạy đầu: 4 test đỏ vì vậy) → đóng sau MỖI test.
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

  /** Chủ + org mới, upload THẬT qua HTTP → id meeting `queued`. */
  async function uploadMeeting(): Promise<string> {
    const owner = await registerUser(app);
    const orgId = (
      await http().post('/v1/orgs').set(as(owner)).send({ name: 'Pipeline' }).expect(201)
    ).body.data.id as string;
    return uploadAudioMeeting(app, owner, orgId, audio);
  }
  const meetingRow = async (id: string) =>
    (await db.select().from(meetings).where(eq(meetings.id, id)))[0]!;
  const waitStatus = (id: string, status: string, timeout = 20_000) =>
    vi.waitFor(async () => expect((await meetingRow(id)).status).toBe(status), {
      timeout,
      interval: 100,
    });
  const jobId = (name: string, id: string, attempt = 1) => `${name}.${id}.a${attempt}`;
  /** Retry có backoff dài → chờ job sang `delayed` rồi đẩy chạy ngay. */
  async function promoteWhenDelayed(queue: Queue, id: string) {
    await vi.waitFor(
      async () => expect(await (await queue.getJob(id))?.getState()).toBe('delayed'),
      {
        timeout: 15_000,
        interval: 100,
      },
    );
    await (await queue.getJob(id))!.promote();
  }

  it('upload HTTP → complete → worker chạy preprocess → transcribe (queue riêng) → summarize → completed', async () => {
    await startWorker();
    const id = await uploadMeeting();
    await waitStatus(id, 'completed');
    const [segments, summaries, transcribeJob] = [
      await db.select().from(transcriptSegments).where(eq(transcriptSegments.meetingId, id)),
      await db.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id)),
      await transcriptionQueue.getJob(jobId(JobName.MeetingTranscribe, id)),
    ];
    expect([segments.length, summaries.length, await transcribeJob?.getState()]).toEqual([
      2,
      1,
      'completed',
    ]);
  });

  it('summarize lỗi TẠM 2 lần rồi được → completed sau 3 lần thử', async () => {
    const summarizer = new FakeSummarizer({ failTimes: 2 });
    await startWorker({ summarizer });
    const id = await uploadMeeting();
    const summarizeJob = jobId(JobName.MeetingSummarize, id);
    await promoteWhenDelayed(defaultQueue, summarizeJob);
    await promoteWhenDelayed(defaultQueue, summarizeJob);
    await waitStatus(id, 'completed');
    // BullMQ 6 đếm CẢ lần thử thành công cuối vào `attemptsMade` (lần đầu viết test đoán 2 — sai).
    expect([summarizer.calls, (await defaultQueue.getJob(summarizeJob))?.attemptsMade]).toEqual([
      3, 3,
    ]);
  });

  // Đột biến: không đổi PermanentPipelineError thành UnrecoverableError → BullMQ retry 5 lần.
  it('lỗi VĨNH VIỄN (LLM) → failed ngay sau 1 lần thử, failure_code đúng', async () => {
    await startWorker({ summarizer: new FakeSummarizer({ permanentFailure: true }) });
    const id = await uploadMeeting();
    await waitStatus(id, 'failed');
    const job = await defaultQueue.getJob(jobId(JobName.MeetingSummarize, id));
    const row = await meetingRow(id);
    expect([row.failureCode, await job?.getState(), job?.attemptsMade]).toEqual([
      'SUMMARIZE_FAILED',
      'failed',
      1,
    ]);
  });

  // Đột biến: đánh `failed` ở MỌI sự kiện failed (không kiểm hết lượt) → failed ngay lần đầu, mất retry.
  it('transcribe lỗi tạm HẾT lượt (2) → failed TRANSCRIBE_FAILED; lần đầu chưa failed', async () => {
    await startWorker({ speech: new FakeSpeechToText({ failTimes: 5 }) });
    const id = await uploadMeeting();
    const transcribeJob = jobId(JobName.MeetingTranscribe, id);
    await vi.waitFor(
      async () =>
        expect(await (await transcriptionQueue.getJob(transcribeJob))?.getState()).toBe('delayed'),
      {
        timeout: 15_000,
        interval: 100,
      },
    );
    const afterFirst = (await meetingRow(id)).status;
    await (await transcriptionQueue.getJob(transcribeJob))!.promote();
    await waitStatus(id, 'failed');
    expect([afterFirst, (await meetingRow(id)).failureCode]).toEqual([
      'transcribing',
      'TRANSCRIBE_FAILED',
    ]);
  });

  it('job `meeting.preprocess` kiểu M5 (payload không có `attempt`) vẫn chạy tới completed', async () => {
    // Như dữ liệu thật của M5: meeting CHƯA từng chạy, job đúng hình dạng cũ. (Lần đầu test làm lại
    // trên meeting đã completed → `meeting.transcribe…a1` còn được giữ → enqueue cùng jobId bị NUỐT.)
    const id = await uploadMeeting(); // chưa có worker → job mới (có `attempt`) nằm chờ
    await (await defaultQueue.getJob(jobId(JobName.MeetingPreprocess, id)))!.remove();
    await defaultQueue.add(
      JobName.MeetingPreprocess,
      { meetingId: id, requestId: null },
      { jobId: jobId(JobName.MeetingPreprocess, id) },
    );
    await startWorker();
    await waitStatus(id, 'completed');
    expect((await meetingRow(id)).attempt).toBe(1);
  });

  // Đột biến: bỏ `beforeApplicationShutdown` → worker.close() chờ job treo mãi (test hết giờ).
  it('TẮT worker giữa lúc transcribe → job về delayed (không tốn lượt), lease nhả; worker mới chạy tiếp', async () => {
    const hanging = new HangingSpeech();
    const first = await startWorker({ speech: hanging });
    const id = await uploadMeeting();
    await hanging.started.promise;
    await first.close();
    workers.splice(workers.indexOf(first), 1);

    const transcribeJob = jobId(JobName.MeetingTranscribe, id);
    const job = await transcriptionQueue.getJob(transcribeJob);
    const row = await meetingRow(id);
    expect([await job?.getState(), job?.attemptsMade, row.status, row.stageToken]).toEqual([
      'delayed',
      0,
      'transcribing',
      null,
    ]);
    await startWorker();
    await job!.promote();
    await waitStatus(id, 'completed');
  });
});
