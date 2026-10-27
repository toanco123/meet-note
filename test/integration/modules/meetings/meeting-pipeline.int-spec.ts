import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  meetings,
  meetingSummaries,
  transcriptSegments,
} from '../../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../../src/infra/llm/fake.summarizer.js';
import type { Summarizer } from '../../../../src/infra/llm/llm.types.js';
import { MediaTools } from '../../../../src/infra/media/media-tools.js';
import { runProcess } from '../../../../src/infra/process/run-process.js';
import { FakeSpeechToText } from '../../../../src/infra/speech/fake.speech-to-text.js';
import type { SpeechToText } from '../../../../src/infra/speech/speech.types.js';
import { PermanentPipelineError } from '../../../../src/modules/meetings/meeting-pipeline.errors.js';
import type {
  PipelineJob,
  PipelineOptions,
  PipelineScheduler,
  PipelineStep,
} from '../../../../src/modules/meetings/meetings.types.js';
import { ActionItemExtractionService } from '../../../../src/modules/action-items/action-item-extraction.service.js';
import { ActionItemsRepository } from '../../../../src/modules/action-items/action-items.repository.js';
import { MeetingPipelineRepository } from '../../../../src/modules/meetings/repositories/meeting-pipeline.repository.js';
import { MeetingPipelineService } from '../../../../src/modules/meetings/services/meeting-pipeline.service.js';
import {
  insertMeeting,
  insertOrg,
  insertUpload,
  insertUser,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { createTestStorage } from '../../../support/storage.js';
import { realtimeStub } from '../../../support/realtime-stub.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';

const OPTIONS: PipelineOptions = {
  maxDurationMs: 4 * 3600_000,
  mediaTimeoutMs: 30_000,
  transcribeTimeoutFactor: 3,
  transcribeBaseTimeoutMs: 60_000,
  language: 'auto',
  preprocessLeaseMs: 60_000,
  summarizeLeaseMs: 60_000,
  leaseMarginMs: 10_000,
};

/**
 * Pipeline service (M6 B4) với Postgres + RustFS + ffmpeg THẬT, speech / LLM giả, kết nối bằng user
 * worker như production. Chưa có BullMQ: bộ ghi thay cho scheduler.
 */
describe('MeetingPipelineService (Postgres + RustFS + ffmpeg thật)', () => {
  let t: TestDb;
  let dir: string;
  const { storage, close } = createTestStorage();
  const repo = () => new MeetingPipelineRepository(t.db);
  const files: Record<'tone' | 'video' | 'garbage', string> = { tone: '', video: '', garbage: '' };

  beforeAll(async () => {
    t = createTestDb(); // user worker (BYPASSRLS)
    dir = await mkdtemp(join(tmpdir(), 'meetnote-pipeline-test-'));
    const ffmpeg = (...args: string[]) =>
      runProcess('ffmpeg', {
        args: ['-nostdin', '-loglevel', 'error', '-y', ...args],
        timeoutMs: 30_000,
      });
    files.tone = join(dir, 'tone.m4a');
    files.video = join(dir, 'video.mp4');
    files.garbage = join(dir, 'garbage.m4a');
    await ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', files.tone);
    await ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=64x64:rate=10',
      '-c:v',
      'mpeg4',
      files.video,
    );
    await writeFile(files.garbage, randomBytes(32 * 1024));
  });

  afterAll(async () => {
    close();
    await t.close();
    await rm(dir, { recursive: true, force: true });
  });

  function recorder() {
    const calls: Array<[PipelineStep, PipelineJob]> = [];
    const scheduler: PipelineScheduler = {
      enqueue: async (step, job) => void calls.push([step, job]),
    };
    return { calls, scheduler };
  }
  function pipeline(
    over: {
      speech?: SpeechToText;
      summarizer?: Summarizer;
      media?: MediaTools;
      options?: Partial<PipelineOptions>;
    } = {},
  ) {
    const rec = recorder();
    const service = new MeetingPipelineService(
      t.db,
      repo(),
      storage,
      over.media ?? new MediaTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }),
      over.speech ?? new FakeSpeechToText(),
      over.summarizer ?? new FakeSummarizer(),
      rec.scheduler,
      { ...OPTIONS, ...over.options },
      realtimeStub.useValue,
      new NotificationsService(new NotificationsRepository(t.db), realtimeStub.useValue),
      new ActionItemExtractionService(new ActionItemsRepository(t.db)),
    );
    return { service, calls: rec.calls };
  }

  /** Meeting `queued` + file gốc thật trên RustFS + upload `completed` mang sha256 (M5). */
  async function meetingWith(file: keyof typeof files, sha256Override?: string) {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const key = `orgs/${org.id}/uploads/${randomUUID()}/source`;
    await storage.uploadFile(key, files[file], 'audio/mp4');
    const meeting = await insertMeeting(t.db, org.id, owner.id, {
      title: 'Giao ban',
      sourceObjectKey: key,
    });
    const content = await readFile(files[file]);
    await insertUpload(t.db, org.id, owner.id, {
      status: 'completed',
      meetingId: meeting.id,
      completedAt: new Date(),
      objectKey: key,
      sizeBytes: content.length,
      totalParts: 1, // uploads_total_parts_ck: ceil(size / chunk) — file test chỉ vài chục KB
      sha256: sha256Override ?? createHash('sha256').update(content).digest('hex'),
    });
    return {
      id: meeting.id,
      orgId: org.id,
      job: { meetingId: meeting.id, attempt: 1, requestId: null },
    };
  }
  const row = async (id: string) =>
    (await t.db.select().from(meetings).where(eq(meetings.id, id)))[0]!;
  const segmentCount = async (id: string) =>
    (await t.db.select().from(transcriptSegments).where(eq(transcriptSegments.meetingId, id)))
      .length;

  it('đi hết queued → completed: audio chuẩn hoá trên S3, đoạn transcript, tóm tắt; enqueue bước kế SAU mỗi bước', async () => {
    const m = await meetingWith('tone');
    const { service, calls } = pipeline();
    const progress: number[] = [];

    const outcomes = [
      await service.preprocess(m.job),
      await service.transcribe(m.job, { onProgress: (_s, p) => progress.push(p) }),
      await service.summarize(m.job),
    ];
    const final = await row(m.id);
    const [summary] = await t.db
      .select()
      .from(meetingSummaries)
      .where(eq(meetingSummaries.meetingId, m.id));

    expect(outcomes).toEqual(['done', 'done', 'done']);
    expect(calls.map(([step]) => step)).toEqual(['transcribe', 'summarize']);
    expect([final.status, final.language, final.stageToken, final.stageLeaseUntil]).toEqual([
      'completed',
      'vi',
      null,
      null,
    ]);
    expect(Math.abs((final.durationMs ?? 0) - 3_000)).toBeLessThan(100);
    expect(await storage.headObject(final.audioObjectKey!)).toBeDefined();
    expect([await segmentCount(m.id), summary?.model, progress]).toEqual([
      2,
      'fake',
      [25, 50, 75, 100],
    ]);
  });

  it('job lặp / cũ / meeting đã xoá → skipped, không đổi gì', async () => {
    const m = await meetingWith('tone');
    const { service } = pipeline();
    await service.preprocess(m.job);
    const again = await service.preprocess(m.job); // chặng đã sang transcribing
    const oldAttempt = await service.transcribe({ ...m.job, attempt: 0 });
    await t.db.update(meetings).set({ deletedAt: new Date() }).where(eq(meetings.id, m.id));
    const deleted = await service.transcribe(m.job);
    expect([again, oldAttempt, deleted, (await row(m.id)).status]).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'transcribing',
    ]);
  });

  // Đột biến: replaceSegments không xoá trước (append) → 4 đoạn.
  it('chạy lại bước đã xong (lease hết hạn, job bị chạy lại) → THAY đoạn / tóm tắt, không nhân đôi', async () => {
    const m = await meetingWith('tone');
    const { service } = pipeline();
    await service.preprocess(m.job);
    await service.transcribe(m.job);
    await service.summarize(m.job);
    // Giả lập: một job transcribe "bị stalled" được chạy lại sau khi lease cũ hết hạn.
    await t.db.update(meetings).set({ status: 'transcribing' }).where(eq(meetings.id, m.id));
    await service.transcribe(m.job);
    await service.summarize(m.job);
    const summaries = await t.db
      .select()
      .from(meetingSummaries)
      .where(eq(meetingSummaries.meetingId, m.id));
    expect([await segmentCount(m.id), summaries.length, (await row(m.id)).status]).toEqual([
      2,
      1,
      'completed',
    ]);
  });

  it.each([
    ['sai sha256', 'tone', 'f'.repeat(64), 'SOURCE_CHECKSUM_MISMATCH'],
    ['không có audio', 'video', undefined, 'MEDIA_NO_AUDIO'],
    ['file rác', 'garbage', undefined, 'MEDIA_UNREADABLE'],
  ] as const)('%s → PermanentPipelineError %s, nhả lease', async (_label, file, sha, code) => {
    const m = await meetingWith(file, sha);
    const error = await pipeline()
      .service.preprocess(m.job)
      .catch((e: unknown) => e);
    const after = await row(m.id);
    expect([(error as PermanentPipelineError).code, after.stageToken, after.status]).toEqual([
      code,
      null,
      'preprocessing',
    ]);
  });

  it('dài hơn giới hạn → MEDIA_TOO_LONG (không cần file 4 giờ: giới hạn là tham số)', async () => {
    const m = await meetingWith('tone');
    const error = await pipeline({ options: { maxDurationMs: 2_000 } })
      .service.preprocess(m.job)
      .catch((e: unknown) => e);
    expect((error as PermanentPipelineError).code).toBe('MEDIA_TOO_LONG');
  });

  // Đột biến: không nhả lease khi lỗi → retry thấy lease còn hạn → skipped, meeting kẹt.
  it('lỗi TẠM (whisper lỗi lần đầu) → ném lỗi thường, nhả lease → lần retry chạy được', async () => {
    const m = await meetingWith('tone');
    const { service } = pipeline({ speech: new FakeSpeechToText({ failTimes: 1 }) });
    await service.preprocess(m.job);
    const first = await service.transcribe(m.job).catch((e: unknown) => e);
    const retry = await service.transcribe(m.job);
    expect([first instanceof PermanentPipelineError, first instanceof Error, retry]).toEqual([
      false,
      true,
      'done',
    ]);
  });

  it('LLM lỗi vĩnh viễn → SUMMARIZE_FAILED; fail() đưa về failed đúng attempt', async () => {
    const m = await meetingWith('tone');
    const { service } = pipeline({ summarizer: new FakeSummarizer({ permanentFailure: true }) });
    await service.preprocess(m.job);
    await service.transcribe(m.job);
    const error = await service.summarize(m.job).catch((e: unknown) => e);
    // sự kiện của lần chạy cũ tới muộn → không đè
    const staleEvent = Boolean(await repo().fail(t.db, m.id, 0, 'SUMMARIZE_FAILED', 'x'));
    const failed = Boolean(
      await repo().fail(t.db, m.id, 1, 'SUMMARIZE_FAILED', 'Không tạo được bản tóm tắt.'),
    );
    const after = await row(m.id);
    expect([
      (error as PermanentPipelineError).code,
      staleEvent,
      failed,
      after.status,
      after.failureCode,
    ]).toEqual(['SUMMARIZE_FAILED', false, true, 'failed', 'SUMMARIZE_FAILED']);
  });

  it('transcript rỗng (im lặng) → tóm tắt cố định, KHÔNG gọi LLM', async () => {
    const m = await meetingWith('tone');
    const summarizer = new FakeSummarizer();
    const { service } = pipeline({ speech: new FakeSpeechToText({ segments: [] }), summarizer });
    await service.preprocess(m.job);
    await service.transcribe(m.job);
    await service.summarize(m.job);
    expect([summarizer.calls, (await row(m.id)).status]).toEqual([0, 'completed']);
  });

  // Đột biến: bỏ điều kiện lease trong `claim` → cả hai cùng chạy ffmpeg.
  it('RACE: 2 lần preprocess SONG SONG cùng meeting → đúng 1 lần chạy ffmpeg', async () => {
    const m = await meetingWith('tone');
    let conversions = 0;
    const media = new MediaTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    const original = media.toWav16kMono.bind(media);
    media.toWav16kMono = async (...args) => {
      conversions++;
      return original(...args);
    };
    const { service, calls } = pipeline({ media });
    const outcomes = await Promise.all([service.preprocess(m.job), service.preprocess(m.job)]);
    expect([outcomes.sort(), conversions, calls.length]).toEqual([['done', 'skipped'], 1, 1]);
  });

  // Đột biến: `advance` không kiểm token → ghi kết quả dù đã mất lease.
  it('mất lease giữa chừng (worker khác nhận lại) → không ghi kết quả, không enqueue', async () => {
    const m = await meetingWith('tone');
    const media = new MediaTools({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    const original = media.toWav16kMono.bind(media);
    media.toWav16kMono = async (...args) => {
      await original(...args);
      // Trong lúc ta đang chạy, lease bị coi là hết hạn và một worker khác nhận việc (token mới).
      await t.db.execute(
        sql`update meetings set stage_token = gen_random_uuid() where id = ${m.id}`,
      );
    };
    const { service, calls } = pipeline({ media });
    const outcome = await service.preprocess(m.job);
    const after = await row(m.id);
    expect([outcome, calls.length, after.status, after.audioObjectKey]).toEqual([
      'skipped',
      0,
      'preprocessing',
      null,
    ]);
  });
});
