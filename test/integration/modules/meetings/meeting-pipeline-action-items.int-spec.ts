import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  meetings,
  meetingSummaries,
  transcriptSegments,
} from '../../../../src/infra/database/schema/index.js';
import { FakeSummarizer } from '../../../../src/infra/llm/fake.summarizer.js';
import type { SummaryActionItem } from '../../../../src/infra/llm/llm.types.js';
import { FakeSpeechToText } from '../../../../src/infra/speech/fake.speech-to-text.js';
import { ActionItemExtractionService } from '../../../../src/modules/action-items/services/action-item-extraction.service.js';
import { ActionItemsRepository } from '../../../../src/modules/action-items/action-items.repository.js';
import type {
  PipelineOptions,
  PipelineScheduler,
} from '../../../../src/modules/meetings/meetings.types.js';
import { MeetingPipelineRepository } from '../../../../src/modules/meetings/repositories/meeting-pipeline.repository.js';
import { MeetingPipelineService } from '../../../../src/modules/meetings/services/meeting-pipeline.service.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import { addMember, insertMeeting, insertOrg, insertUser } from '../../../support/db-factories.js';
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

const item = (over: Partial<SummaryActionItem> = {}): SummaryActionItem => ({
  owner: null,
  task: 'Việc',
  due: null,
  dueDate: null,
  ...over,
});

/**
 * Trích action item trong bước tóm tắt (M12 B3): map người phụ trách, idempotency khi chạy lại, không
 * đè việc đã sửa, và CÙNG SỐNG / CÙNG CHẾT với tóm tắt (cùng transaction). Không cần ffmpeg / S3.
 */
describe('MeetingPipelineService.summarize → action_items (Postgres thật, LLM giả)', () => {
  let t: TestDb;
  let orgId: string;
  let ownerId: string;
  let binhId: string;
  let lanId: string;
  let repo: ActionItemsRepository;

  beforeAll(async () => {
    t = createTestDb(); // user worker (BYPASSRLS)
    repo = new ActionItemsRepository(t.db);
    ownerId = (await insertUser(t.db, { displayName: 'Phạm Quốc Hùng' })).id;
    orgId = (await insertOrg(t.db, ownerId)).id;
    binhId = (await insertUser(t.db, { displayName: 'Nguyễn Văn Bình' })).id;
    lanId = (await insertUser(t.db, { displayName: 'Trần Thị Lan' })).id;
    await addMember(t.db, orgId, binhId);
    await addMember(t.db, orgId, lanId);
  });

  afterAll(async () => {
    await t.close();
  });

  function service(
    summarizer: Pick<FakeSummarizer, 'summarize'>,
    extraction: Pick<ActionItemExtractionService, 'extract'> = new ActionItemExtractionService(
      repo,
    ),
    notifications: Pick<NotificationsService, 'recordInTx'> = new NotificationsService(
      new NotificationsRepository(t.db),
      realtimeStub.useValue,
    ),
  ) {
    const scheduler: PipelineScheduler = { enqueue: async () => undefined };
    return new MeetingPipelineService(
      t.db,
      new MeetingPipelineRepository(t.db),
      {} as never,
      {} as never,
      new FakeSpeechToText(),
      summarizer as FakeSummarizer,
      scheduler,
      OPTIONS,
      realtimeStub.useValue,
      notifications as NotificationsService,
      extraction as ActionItemExtractionService,
    );
  }

  async function summarizingMeeting() {
    const m = await insertMeeting(t.db, orgId, ownerId, { status: 'summarizing' });
    await t.db
      .insert(transcriptSegments)
      .values({ meetingId: m.id, orgId, seq: 0, startMs: 0, endMs: 900, text: 'Bình gửi báo giá' });
    return { id: m.id, job: { meetingId: m.id, attempt: 1, requestId: null } };
  }
  const itemsOf = (meetingId: string) => repo.listByMeeting(meetingId);
  const statusOf = async (id: string) =>
    (await t.db.select({ s: meetings.status }).from(meetings).where(eq(meetings.id, id)))[0]!.s;
  /** Đưa meeting về chặng tóm tắt chưa ai giữ — như thể lease hết hạn và job bị chạy lại. */
  const rewind = (id: string) =>
    t.db
      .update(meetings)
      .set({ status: 'summarizing', stageToken: null, stageLeaseUntil: null })
      .where(eq(meetings.id, id));

  it('trích việc: người phụ trách khớp thành viên, không khớp thì giữ chữ gốc, hạn chữ + ngày', async () => {
    const summarizer = new FakeSummarizer({
      actionItems: [
        item({ task: 'Gửi báo giá', owner: 'anh Bình', due: 'thứ sáu', dueDate: '2026-10-30' }),
        item({ task: 'Đặt phòng', owner: 'Lan' }),
        item({ task: 'Việc của ai đó', owner: 'Hoàng' }),
        item({ task: 'Việc chung' }),
      ],
    });
    const m = await summarizingMeeting();
    await service(summarizer).summarize(m.job);

    expect(await statusOf(m.id)).toBe('completed');
    expect(
      (await itemsOf(m.id)).map((i) => [
        i.sourceIndex,
        i.task,
        i.ownerName,
        i.assigneeId,
        i.dueText,
        i.dueDate,
        i.origin,
        i.status,
      ]),
    ).toEqual([
      [0, 'Gửi báo giá', 'anh Bình', binhId, 'thứ sáu', '2026-10-30', 'ai', 'open'],
      [1, 'Đặt phòng', 'Lan', lanId, null, null, 'ai', 'open'],
      [2, 'Việc của ai đó', 'Hoàng', null, null, null, 'ai', 'open'],
      [3, 'Việc chung', null, null, null, null, 'ai', 'open'],
    ]);
  });

  it('hai người cùng tên gọi trong org → không gán (mơ hồ), việc vẫn được tạo', async () => {
    const o = (await insertUser(t.db)).id;
    const org2 = (await insertOrg(t.db, o)).id;
    for (const name of ['Nguyễn Văn Tú', 'Lê Thị Tú']) {
      await addMember(t.db, org2, (await insertUser(t.db, { displayName: name })).id);
    }
    const m = await insertMeeting(t.db, org2, o, { status: 'summarizing' });
    await t.db
      .insert(transcriptSegments)
      .values({ meetingId: m.id, orgId: org2, seq: 0, startMs: 0, endMs: 900, text: 'x' });
    const summarizer = new FakeSummarizer({ actionItems: [item({ owner: 'Tú' })] });
    await service(summarizer).summarize({ meetingId: m.id, attempt: 1, requestId: null });
    expect((await itemsOf(m.id)).map((i) => [i.ownerName, i.assigneeId])).toEqual([['Tú', null]]);
  });

  it('thành viên của org KHÁC không bao giờ được gán', async () => {
    const stranger = await insertUser(t.db, { displayName: 'Võ Thị Mai' });
    const otherOrg = (await insertOrg(t.db, stranger.id)).id;
    expect(otherOrg).not.toBe(orgId);
    const summarizer = new FakeSummarizer({ actionItems: [item({ owner: 'Mai' })] });
    const m = await summarizingMeeting();
    await service(summarizer).summarize(m.job);
    expect((await itemsOf(m.id))[0]?.assigneeId).toBeNull();
  });

  // Đột biến: `onConflictDoNothing` → `DoUpdate` (hoặc bỏ): chạy lại đè / nhân đôi.
  it('CHẠY LẠI bước tóm tắt: không sinh trùng, KHÔNG đè việc đã sửa / đã done, kể cả khi model trả khác', async () => {
    const m = await summarizingMeeting();
    await service(
      new FakeSummarizer({
        actionItems: [item({ task: 'Bản máy 0' }), item({ task: 'Việc hai' })],
      }),
    ).summarize(m.job);
    const [first, second] = await itemsOf(m.id);
    await repo.updateIfVersion(first!.id, 1, { task: 'Bản người sửa', assigneeId: lanId }, ownerId);
    await repo.updateIfVersion(second!.id, 1, { status: 'done' }, ownerId);

    await rewind(m.id);
    await service(
      new FakeSummarizer({
        actionItems: [
          item({ task: 'Máy trả khác' }),
          item({ task: 'Máy trả khác nữa' }),
          item({ task: 'Việc thứ ba mới' }),
        ],
      }),
    ).summarize(m.job);

    expect(
      (await itemsOf(m.id)).map((i) => [i.sourceIndex, i.task, i.status, i.assigneeId, i.version]),
    ).toEqual([
      [0, 'Bản người sửa', 'open', lanId, 2],
      [1, 'Việc hai', 'done', null, 2],
      [2, 'Việc thứ ba mới', 'open', null, 1], // chỉ vị trí MỚI được thêm
    ]);
    // Tóm tắt thì được thay bằng bản mới (hành vi M6 không đổi).
    expect(
      (await t.db.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, m.id)))[0]
        ?.content,
    ).toMatchObject({
      actionItems: [
        { task: 'Máy trả khác' },
        { task: 'Máy trả khác nữa' },
        { task: 'Việc thứ ba mới' },
      ],
    });
  });

  it('mất lease giữa chừng (worker khác nhận lại) → KHÔNG tóm tắt, KHÔNG việc, chưa completed', async () => {
    const m = await summarizingMeeting();
    const stealing = {
      summarize: async () => {
        // Lúc LLM đang chạy, lease bị worker khác lấy: token đổi.
        await t.db
          .update(meetings)
          .set({ stageToken: sql`gen_random_uuid()` })
          .where(eq(meetings.id, m.id));
        return new FakeSummarizer({ actionItems: [item({ task: 'ma' })] }).summarize({
          meetingTitle: 't',
          meetingDate: '2026-10-27',
          segments: [],
        });
      },
    };
    await service(stealing).summarize(m.job);
    expect(await itemsOf(m.id)).toEqual([]);
    expect(
      await t.db.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, m.id)),
    ).toEqual([]);
    expect(await statusOf(m.id)).toBe('summarizing');
  });

  // Đột biến: gọi `extract` NGOÀI transaction (hoặc nuốt lỗi) → tóm tắt đã commit mà thiếu việc.
  it('trích việc LỖI → rollback cả tóm tắt lẫn completed (cùng transaction), job retry được', async () => {
    const m = await summarizingMeeting();
    const broken = {
      extract: vi.fn<() => Promise<number>>().mockRejectedValue(new Error('DB chập chờn')),
    };
    await expect(
      service(new FakeSummarizer({ actionItems: [item()] }), broken).summarize(m.job),
    ).rejects.toThrow('DB chập chờn');
    expect(await statusOf(m.id)).toBe('summarizing');
    expect(
      await t.db.select().from(meetingSummaries).where(eq(meetingSummaries.meetingId, m.id)),
    ).toEqual([]);
    expect(await itemsOf(m.id)).toEqual([]);

    // Lần retry (lease đã nhả khi lỗi) chạy được và ra đủ.
    await service(new FakeSummarizer({ actionItems: [item({ task: 'ổn rồi' })] })).summarize(m.job);
    expect(await statusOf(m.id)).toBe('completed');
    expect((await itemsOf(m.id)).map((i) => i.task)).toEqual(['ổn rồi']);
  });

  // Đột biến: `extract` chạy bằng `this.db` thay vì `tx` → việc đã commit dù tóm tắt rollback.
  it('bước SAU trích việc trong cùng transaction lỗi (thông báo) → việc rollback theo, không mồ côi', async () => {
    const m = await summarizingMeeting();
    const failing = {
      recordInTx: vi
        .fn<NotificationsService['recordInTx']>()
        .mockRejectedValue(new Error('thông báo lỗi')),
    };
    await expect(
      service(
        new FakeSummarizer({ actionItems: [item({ owner: 'Bình' })] }),
        undefined,
        failing,
      ).summarize(m.job),
    ).rejects.toThrow('thông báo lỗi');
    expect(failing.recordInTx).toHaveBeenCalledTimes(1); // đã chạy tới đây, tức extract đã chạy xong
    expect(await itemsOf(m.id)).toEqual([]);
    expect(await statusOf(m.id)).toBe('summarizing');
  });

  it('không việc nào nêu tên người → không tải danh sách thành viên (tiết kiệm truy vấn)', async () => {
    const spy = vi.spyOn(repo, 'listMemberNames');
    const m = await summarizingMeeting();
    await service(new FakeSummarizer({ actionItems: [item(), item({ owner: '  ' })] })).summarize(
      m.job,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(await itemsOf(m.id)).toHaveLength(2);
    spy.mockRestore();
  });

  it('transcript rỗng / tóm tắt không có việc → không việc nào, vẫn completed', async () => {
    const m = await insertMeeting(t.db, orgId, ownerId, { status: 'summarizing' });
    await service(new FakeSummarizer({ actionItems: [item()] })).summarize({
      meetingId: m.id,
      attempt: 1,
      requestId: null,
    });
    expect(await statusOf(m.id)).toBe('completed');
    expect(await itemsOf(m.id)).toEqual([]);
  });
});
