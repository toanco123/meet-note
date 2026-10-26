import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/infra/database/database.types.js';
import { meetings, notifications } from '../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../src/infra/llm/fake.summarizer.js';
import { REALTIME_PUBLISHER } from '../../../src/infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../src/infra/realtime/realtime.types.js';
import type { SpeechToText, TranscribeOptions } from '../../../src/infra/speech/speech.types.js';
import { createTestApp, createTestWorker } from '../../support/app.js';
import { fixtureDb } from '../../support/db.js';
import { bearer, registerUser, type TestUser } from '../../support/factories.js';
import { generateAudio, uploadAudioMeeting } from '../../support/pipeline.js';
import { connectRealtime, portOf } from '../../support/realtime.js';

/** Báo tiến độ DÀY (mỗi 1 %) như whisper thật — để kiểm giãn tần suất phát. */
class ChattySpeech implements SpeechToText {
  async transcribe(_wav: string, options: TranscribeOptions) {
    for (let p = 0; p <= 100; p++) options.onProgress?.(p);
    return { language: 'vi', segments: [{ startMs: 0, endMs: 1_000, text: 'Xin chào.' }] };
  }
}

interface Captured {
  status: Array<{ status: string; failureCode: string | null }>;
  progress: number[];
  notifications: Array<{ type: string; payload: Record<string, unknown> }>;
}

/** Realtime + thông báo của pipeline (M6 B6): socket THẬT, worker THẬT, speech / LLM giả. */
describe('Pipeline: meeting.status / meeting.progress / thông báo (e2e)', () => {
  let app: INestApplication<App>;
  let db: Database;
  let audio: Buffer;
  const workers: INestApplicationContext[] = [];
  const sockets: Socket[] = [];
  const http = () => request(app.getHttpServer());
  const as = (u: TestUser) => bearer(u.tokens.accessToken);

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    db = fixtureDb();
    audio = await generateAudio();
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.close();
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await app.close();
  });

  /** Chủ đăng nhập socket TRƯỚC khi upload (bắt cả `queued`), upload + complete, subscribe room meeting. */
  async function ownerWithMeeting() {
    const owner = await registerUser(app);
    const { socket, outcome } = await connectRealtime(portOf(app), owner.tokens.accessToken);
    sockets.push(socket);
    if (outcome !== 'OK') throw new Error(outcome);
    const captured: Captured = { status: [], progress: [], notifications: [] };
    socket.on('meeting.status', (e: { status: string; failureCode: string | null }) =>
      captured.status.push({ status: e.status, failureCode: e.failureCode }),
    );
    socket.on('meeting.progress', (e: { percent: number }) => captured.progress.push(e.percent));
    socket.on('notification.created', (e: Captured['notifications'][number]) =>
      captured.notifications.push(e),
    );

    const orgId = (
      await http().post('/v1/orgs').set(as(owner)).send({ name: 'Sự kiện' }).expect(201)
    ).body.data.id as string;
    const meetingId = await uploadAudioMeeting(app, owner, orgId, audio, 'Họp sự kiện');
    const ack = (await socket.timeout(3_000).emitWithAck('subscribe', { meetingId })) as {
      data?: unknown;
    };
    if (!ack.data) throw new Error(`subscribe lỗi: ${JSON.stringify(ack)}`);
    return { owner, meetingId, captured };
  }
  const waitFor = (fn: () => void | Promise<void>) =>
    vi.waitFor(fn, { timeout: 20_000, interval: 100 });

  it('chủ nhận đủ chuỗi meeting.status → completed, tiến độ transcribe, thông báo meeting.completed', async () => {
    const { owner, meetingId, captured } = await ownerWithMeeting();
    workers.push(await createTestWorker()); // FakeSpeechToText báo 25 / 50 / 75 / 100
    await waitFor(() => expect(captured.status.at(-1)?.status).toBe('completed'));
    await waitFor(() => expect(captured.notifications).toHaveLength(1));

    expect(captured.status.map((e) => e.status)).toEqual([
      'queued',
      'preprocessing',
      'transcribing',
      'summarizing',
      'completed',
    ]);
    expect([captured.progress, captured.notifications[0]]).toEqual([
      [25, 50, 75, 100],
      {
        ...captured.notifications[0],
        type: 'meeting.completed',
        payload: { meetingId, meetingTitle: 'Họp sự kiện' },
      },
    ]);
    const rows = await db.select().from(notifications).where(eq(notifications.userId, owner.id));
    expect(rows.map((r) => [r.type, r.dedupeKey])).toEqual([
      ['meeting.completed', `meeting-completed.${meetingId}.a1`],
    ]);
  });

  // Đột biến: bỏ giãn tần suất (phát mọi lần whisper báo) → 101 event.
  it('tiến độ báo mỗi 1 % → chỉ phát khi tăng ≥ 5 % (21 event: 0, 5, …, 100)', async () => {
    const { captured } = await ownerWithMeeting();
    workers.push(await createTestWorker({ speech: new ChattySpeech() }));
    await waitFor(() => expect(captured.status.at(-1)?.status).toBe('completed'));
    expect(captured.progress).toEqual(Array.from({ length: 21 }, (_, i) => i * 5));
  });

  it('lỗi vĩnh viễn → meeting.status failed (kèm mã) + thông báo meeting.failed cho chủ', async () => {
    const { meetingId, captured } = await ownerWithMeeting();
    workers.push(
      await createTestWorker({ summarizer: new FakeSummarizer({ permanentFailure: true }) }),
    );
    await waitFor(() => expect(captured.status.at(-1)?.status).toBe('failed'));
    await waitFor(() => expect(captured.notifications).toHaveLength(1));
    expect([
      captured.status.at(-1),
      captured.notifications[0]?.type,
      captured.notifications[0]?.payload,
    ]).toEqual([
      { status: 'failed', failureCode: 'SUMMARIZE_FAILED' },
      'meeting.failed',
      { meetingId, meetingTitle: 'Họp sự kiện', failureCode: 'SUMMARIZE_FAILED' },
    ]);
  });

  // Đột biến: phát `meeting.status` TRONG transaction (trước commit) → connection khác chưa thấy.
  it('meeting.status phát SAU commit: lúc phát `completed`, connection khác đã thấy completed', async () => {
    const { meetingId, captured } = await ownerWithMeeting();
    const worker = await createTestWorker();
    workers.push(worker);
    const publisher = worker.get<RealtimePublisher>(REALTIME_PUBLISHER);
    const original = publisher.emit.bind(publisher);
    const seen: Array<Promise<string | undefined>> = [];
    vi.spyOn(publisher, 'emit').mockImplementation((rooms, event, payload) => {
      const p = payload as { meetingId?: string; status?: string };
      if (event === 'meeting.status' && p.meetingId === meetingId && p.status === 'completed') {
        seen.push(
          db
            .select({ status: meetings.status })
            .from(meetings)
            .where(eq(meetings.id, meetingId))
            .then((r) => r[0]?.status),
        );
      }
      original(rooms, event, payload);
    });
    await waitFor(() => expect(captured.status.at(-1)?.status).toBe('completed'));
    expect(await Promise.all(seen)).toEqual(['completed']);
  });
});
