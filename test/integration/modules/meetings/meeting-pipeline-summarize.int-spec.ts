import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  meetings,
  meetingSummaries,
  transcriptSegments,
} from '../../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../../src/infra/llm/fake.summarizer.js';
import type { SummaryActionItem } from '../../../../src/infra/llm/llm.types.js';
import type {
  PipelineOptions,
  PipelineScheduler,
} from '../../../../src/modules/meetings/meetings.types.js';
import { MeetingPipelineRepository } from '../../../../src/modules/meetings/repositories/meeting-pipeline.repository.js';
import { MeetingPipelineService } from '../../../../src/modules/meetings/services/meeting-pipeline.service.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import { FakeSpeechToText } from '../../../../src/infra/speech/fake.speech-to-text.js';
import { insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { realtimeStub } from '../../../support/realtime-stub.js';

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
 * Chỉ BƯỚC TÓM TẮT của pipeline (M12): không cần ffmpeg / S3 nên chạy được ở máy không có chúng —
 * spec đầy đủ `meeting-pipeline.int-spec.ts` thì chết cả file khi thiếu ffmpeg (tạo âm thanh ở
 * `beforeAll`). Meeting dựng sẵn ở chặng `summarizing` với vài đoạn transcript.
 */
describe('MeetingPipelineService.summarize (Postgres thật, LLM giả)', () => {
  let t: TestDb;
  let orgId: string;
  let ownerId: string;

  beforeAll(async () => {
    t = createTestDb(); // user worker (BYPASSRLS)
    ownerId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  function service(summarizer: FakeSummarizer) {
    const scheduler: PipelineScheduler = { enqueue: async () => undefined };
    return new MeetingPipelineService(
      t.db,
      new MeetingPipelineRepository(t.db),
      {} as never, // storage — bước tóm tắt không đụng
      {} as never, // media
      new FakeSpeechToText(),
      summarizer,
      scheduler,
      OPTIONS,
      realtimeStub.useValue,
      new NotificationsService(new NotificationsRepository(t.db), realtimeStub.useValue),
    );
  }

  async function summarizingMeeting(
    recordedAt: Date,
    segments = ['Anh Bình gửi báo giá thứ sáu.'],
  ) {
    const m = await insertMeeting(t.db, orgId, ownerId, { status: 'summarizing', recordedAt });
    if (segments.length > 0)
      await t.db.insert(transcriptSegments).values(
        segments.map((text, seq) => ({
          meetingId: m.id,
          orgId,
          seq,
          startMs: seq * 1000,
          endMs: seq * 1000 + 900,
          text,
        })),
      );
    return { id: m.id, job: { meetingId: m.id, attempt: 1, requestId: null } };
  }
  const summaryOf = async (id: string) =>
    (await t.db.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, id)))[0]!;

  // Đột biến: lấy ngày bằng `toISOString().slice(0, 10)` (UTC) → họp 01:00 sáng giờ VN bị lùi một ngày
  // và "thứ sáu" quy sai một ngày.
  it.each([
    ['2026-10-27T03:00:00Z', '2026-10-27', 'giữa ngày'],
    ['2026-10-27T16:59:59Z', '2026-10-27', '23:59:59 giờ VN — vẫn là 27'],
    ['2026-10-27T17:00:00Z', '2026-10-28', '00:00:00 giờ VN — đã sang 28 dù UTC còn 27'],
    ['2026-12-31T18:30:00Z', '2027-01-01', 'qua năm theo giờ VN'],
  ])('ngày họp truyền cho LLM theo GIỜ VN: %s → %s (%s)', async (recordedAt, expected) => {
    const summarizer = new FakeSummarizer();
    const m = await summarizingMeeting(new Date(recordedAt));
    await service(summarizer).summarize(m.job);
    expect(summarizer.lastInput?.meetingDate).toBe(expected);
  });

  it('tóm tắt lưu cả dueDate của việc, status → completed, promptVersion v2', async () => {
    const items: SummaryActionItem[] = [
      { owner: 'Bình', task: 'Gửi báo giá', due: 'thứ sáu', dueDate: '2026-10-30' },
      { owner: null, task: 'Không hạn', due: null, dueDate: null },
    ];
    const summarizer = new FakeSummarizer({ actionItems: items });
    const m = await summarizingMeeting(new Date('2026-10-27T03:00:00Z'));
    await service(summarizer).summarize(m.job);
    const summary = await summaryOf(m.id);
    expect(summary.promptVersion).toBe('v2');
    expect((summary.content as { actionItems: unknown }).actionItems).toEqual(items);
    expect(
      (await t.db.select({ s: meetings.status }).from(meetings).where(eq(meetings.id, m.id)))[0]!.s,
    ).toBe('completed');
  });

  it('transcript rỗng → tóm tắt cố định không có việc, KHÔNG gọi LLM', async () => {
    const summarizer = new FakeSummarizer();
    const m = await summarizingMeeting(new Date('2026-10-27T03:00:00Z'), []);
    await service(summarizer).summarize(m.job);
    expect(summarizer.calls).toBe(0);
    expect((await summaryOf(m.id)).content).toMatchObject({ actionItems: [] });
  });
});
