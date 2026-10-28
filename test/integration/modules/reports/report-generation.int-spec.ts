import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionItems,
  channels,
  meetingSummaries,
  notifications,
  weeklyReports,
  weeklyReportVersions,
} from '../../../../src/infra/database/schema/index.js';
import { FakeReportWriter } from '../../../../src/infra/llm/fake.report-writer.js';
import { LlmPermanentError, LlmTransientError } from '../../../../src/infra/llm/llm.errors.js';
import type {
  ReportInput,
  ReportResult,
  ReportWriter,
} from '../../../../src/infra/llm/llm.types.js';
import { PermanentReportError } from '../../../../src/modules/reports/report.errors.js';
import { ReportGenerationService } from '../../../../src/modules/reports/services/report-generation.service.js';
import type { RealtimePublisher } from '../../../../src/infra/realtime/realtime.types.js';
import { NotificationsRepository } from '../../../../src/modules/notifications/notifications.repository.js';
import { NotificationFanoutService } from '../../../../src/modules/notifications/services/notification-fanout.service.js';
import { NotificationsService } from '../../../../src/modules/notifications/services/notifications.service.js';
import { ReportsRepository } from '../../../../src/modules/reports/reports.repository.js';
import type { ReportJob } from '../../../../src/modules/reports/reports.types.js';
import {
  addMember,
  insertChannel,
  insertMeeting,
  insertOrg,
  insertUser,
  shareMeeting,
} from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';

const WEEK = '2026-10-05';

/** Writer cho phép test GIỮ lời gọi LLM đang chạy rồi nhả ra khi muốn (mô phỏng worker chậm / chết). */
class GatedWriter implements ReportWriter {
  readonly started = Promise.withResolvers<void>();
  private readonly gate = Promise.withResolvers<void>();
  constructor(private readonly model: string) {}
  release() {
    this.gate.resolve();
  }
  async write(input: ReportInput): Promise<ReportResult> {
    this.started.resolve();
    await this.gate.promise;
    return {
      content: { overview: `từ ${this.model}`, highlights: [], decisions: [], actionItems: [] },
      model: this.model,
      promptVersion: 'v1',
      inputTokens: input.meetings.length,
      outputTokens: 0,
    };
  }
}

/** Dịch vụ tạo báo cáo (M9 B4) với Postgres thật + `ReportWriter` giả: lease, fencing, idempotency. */
describe('ReportGenerationService (Postgres thật)', () => {
  let t: TestDb;
  let repo: ReportsRepository;
  /** Realtime ghi lại: kiểm "đẩy SAU commit" và ai nhận. */
  const emitted: Array<{ rooms: string[]; event: string }> = [];
  const publisher = {
    emit: (rooms: string[], event: string) => emitted.push({ rooms, event }),
  } as unknown as RealtimePublisher;
  /** Fan-out theo lịch được XẾP (không chạy) — việc chạy có test riêng ở notification-fanout. */
  const fanoutCalls: Array<{ reportId: string; version: number }> = [];
  const fanout = {
    enqueueReportReady: (reportId: string, version: number) => {
      fanoutCalls.push({ reportId, version });
      return Promise.resolve();
    },
  } as unknown as NotificationFanoutService;
  const service = (writer: ReportWriter, over: { leaseMs?: number; maxMeetings?: number } = {}) =>
    new ReportGenerationService(
      t.db,
      repo,
      writer,
      { leaseMs: 60_000, maxMeetings: 100, ...over },
      new NotificationsService(new NotificationsRepository(t.db), publisher),
      fanout,
    );

  beforeAll(() => {
    t = createTestDb(8);
    repo = new ReportsRepository(t.db);
  });

  afterAll(async () => {
    await t.close();
  });

  /** Kênh + `n` meeting đủ điều kiện trong WEEK + dòng báo cáo `pending`. */
  async function scenario(n = 3, reportOver: Partial<typeof weeklyReports.$inferInsert> = {}) {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const channel = await insertChannel(t.db, org.id, owner.id, { name: 'Kinh doanh' });
    const meetingIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = await insertMeeting(t.db, org.id, owner.id, {
        title: `Họp ${i}`,
        recordedAt: new Date(Date.UTC(2026, 9, 6, i + 1)),
        status: 'completed',
      });
      await shareMeeting(t.db, org.id, m.id, channel.id);
      await t.db.insert(meetingSummaries).values({
        meetingId: m.id,
        orgId: org.id,
        content: {
          overview: `Tóm tắt ${i}`,
          keyPoints: [],
          decisions: [`Quyết định ${i}`],
          actionItems: [],
        },
        model: 'fake',
        promptVersion: 'v1',
        inputTokens: 1,
        outputTokens: 1,
      });
      meetingIds.push(m.id);
    }
    const [report] = await t.db
      .insert(weeklyReports)
      .values({ channelId: channel.id, orgId: org.id, weekStart: WEEK, ...reportOver })
      .returning();
    const job = (generation = report!.regenerateCount): ReportJob => ({
      reportId: report!.id,
      generation,
      requestId: null,
    });
    return { owner, org, channel, meetingIds, report: report!, job };
  }
  const row = async (id: string) =>
    (await t.db.select().from(weeklyReports).where(eq(weeklyReports.id, id)))[0]!;
  const versions = (id: string) =>
    t.db
      .select()
      .from(weeklyReportVersions)
      .where(eq(weeklyReportVersions.reportId, id))
      .orderBy(weeklyReportVersions.version);

  it('đủ meeting → completed, version 1: nội dung + meetings do server ghép + snapshot id + lease sạch', async () => {
    const s = await scenario(3);
    const writer = new FakeReportWriter();
    const outcome = await service(writer).generate(s.job());
    const [r, vs] = [await row(s.report.id), await versions(s.report.id)];

    expect(outcome).toBe('completed');
    expect([r.status, r.currentVersion, r.generationToken, r.leaseUntil, r.lastError]).toEqual([
      'completed',
      1,
      null,
      null,
      null,
    ]);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({
      version: 1,
      trigger: 'scheduled',
      triggeredBy: null,
      meetingIds: s.meetingIds, // cũ → mới
      truncated: false,
      model: 'fake',
    });
    expect(vs[0]?.content).toMatchObject({
      overview: 'Tuần 2026-10-05 của kênh "Kinh doanh": 3 cuộc họp.',
      decisions: ['Quyết định 0', 'Quyết định 1', 'Quyết định 2'],
      meetings: s.meetingIds.map((id, i) => ({ id, title: `Họp ${i}` })),
    });
    expect(writer.lastInput?.channelName).toBe('Kinh doanh');
  });

  // M12 Q9: danh sách việc quá hạn do SERVER ghép từ bảng `action_items`, không qua model.
  describe('việc quá hạn (M12)', () => {
    const addItems = (orgId: string, meetingId: string, n: number, over = {}) =>
      t.db.insert(actionItems).values(
        Array.from({ length: n }, (_, i) => ({
          orgId,
          meetingId,
          origin: 'manual' as const,
          task: `Quá hạn ${String(i).padStart(2, '0')}`,
          // hạn tăng dần: Quá hạn 00 cũ nhất
          dueDate: `2026-09-${String(i + 1).padStart(2, '0')}`,
          ...over,
        })),
      );
    const contentOf = async (id: string) =>
      (await versions(id))[0]!.content as {
        overdueActionItems: Array<{ task: string; dueDate: string; meetingTitle: string }>;
        overdueActionItemsTruncated: boolean;
      };

    it('ghép vào nội dung báo cáo: chỉ việc open quá hạn, hạn cũ nhất trước, KHÔNG gửi cho model', async () => {
      const s = await scenario(3);
      await addItems(s.org.id, s.meetingIds[0]!, 2);
      await addItems(s.org.id, s.meetingIds[1]!, 1, {
        status: 'done',
        completedAt: new Date(),
        task: 'Đã xong',
      });
      const writer = new FakeReportWriter();
      await service(writer).generate(s.job());
      const content = await contentOf(s.report.id);
      expect(content.overdueActionItems.map((i) => i.task)).toEqual(['Quá hạn 00', 'Quá hạn 01']);
      expect(content.overdueActionItemsTruncated).toBe(false);
      expect(content.overdueActionItems[0]).toMatchObject({
        dueDate: '2026-09-01',
        meetingTitle: 'Họp 0',
      });
      // model không nhìn thấy danh sách này (chỉ server ghép) → prompt không đổi
      expect(JSON.stringify(writer.lastInput)).not.toContain('Quá hạn');
    });

    it('đúng 20 → không cắt; 21 → cắt còn 20 (giữ hạn cũ nhất) và truncated', async () => {
      const exact = await scenario(2);
      await addItems(exact.org.id, exact.meetingIds[0]!, 20);
      await service(new FakeReportWriter()).generate(exact.job());
      const c20 = await contentOf(exact.report.id);
      expect([c20.overdueActionItems.length, c20.overdueActionItemsTruncated]).toEqual([20, false]);

      const over = await scenario(2);
      await addItems(over.org.id, over.meetingIds[0]!, 21);
      await service(new FakeReportWriter()).generate(over.job());
      const c21 = await contentOf(over.report.id);
      expect([c21.overdueActionItems.length, c21.overdueActionItemsTruncated]).toEqual([20, true]);
      expect(c21.overdueActionItems[0]!.task).toBe('Quá hạn 00');
      expect(c21.overdueActionItems.at(-1)!.task).toBe('Quá hạn 19');
    });

    it('không có việc quá hạn → danh sách rỗng, không phải thiếu field', async () => {
      const s = await scenario(2);
      await service(new FakeReportWriter()).generate(s.job());
      expect(await contentOf(s.report.id)).toMatchObject({
        overdueActionItems: [],
        overdueActionItemsTruncated: false,
      });
    });
  });

  it('dưới 2 meeting → skipped, KHÔNG gọi LLM, không có phiên bản', async () => {
    const s = await scenario(1);
    const writer = new FakeReportWriter();
    const outcome = await service(writer).generate(s.job());
    const r = await row(s.report.id);
    expect([
      outcome,
      writer.calls,
      r.status,
      r.currentVersion,
      (await versions(s.report.id)).length,
    ]).toEqual(['skipped', 0, 'skipped', null, 0]);
  });

  // Đột biến: `claim` nhận cả `completed` → job trùng chạy lại và sinh version 2.
  it('IDEMPOTENT: chạy lại cùng job khi đã xong → ignored, vẫn đúng 1 phiên bản, không gọi LLM thêm', async () => {
    const s = await scenario(2);
    const writer = new FakeReportWriter();
    const first = await service(writer).generate(s.job());
    const second = await service(writer).generate(s.job());
    const third = await service(writer).generate(s.job());
    expect([first, second, third, writer.calls, (await versions(s.report.id)).length]).toEqual([
      'completed',
      'ignored',
      'ignored',
      1,
      1,
    ]);
  });

  // Đột biến: bỏ điều kiện lease ở `claim` → cả hai cùng gọi LLM và cùng ghi.
  it('hai worker nhận CÙNG LÚC → chỉ một gọi LLM và ghi; bên kia ignored', async () => {
    const s = await scenario(3);
    const [a, b] = [new GatedWriter('a'), new GatedWriter('b')];
    const [pa, pb] = [service(a).generate(s.job()), service(b).generate(s.job())];
    // Chờ một bên thực sự vào LLM rồi nhả cả hai.
    await Promise.race([a.started.promise, b.started.promise]);
    a.release();
    b.release();
    const outcomes = (await Promise.all([pa, pb])).sort();
    expect([outcomes, (await versions(s.report.id)).length]).toEqual([['completed', 'ignored'], 1]);
  });

  // Đột biến (bài học M6 #9): `claim` chỉ nhận `pending` → retry thấy `generating` → kẹt mãi.
  it('lỗi TẠM → nhả lease; lần retry nhận lại được và hoàn tất (không kẹt `generating`)', async () => {
    const s = await scenario(2);
    const writer = new FakeReportWriter({ failTimes: 1 });
    const svc = service(writer);
    const err = await svc.generate(s.job()).catch((e: unknown) => e);
    const afterFail = await row(s.report.id);
    const retried = await svc.generate(s.job());
    expect(err).toBeInstanceOf(LlmTransientError);
    expect([afterFail.status, afterFail.generationToken, afterFail.leaseUntil]).toEqual([
      'generating', // chặng hiện tại vẫn là generating…
      null, // …nhưng lease đã nhả: nhận lại được ngay
      null,
    ]);
    expect([
      retried,
      (await row(s.report.id)).status,
      (await versions(s.report.id)).length,
    ]).toEqual(['completed', 'completed', 1]);
  });

  it('lỗi VĨNH VIỄN của LLM → PermanentReportError + nhả lease; `fail()` đánh failed, giữ bản cũ', async () => {
    const s = await scenario(2);
    await service(new FakeReportWriter()).generate(s.job()); // v1 đã có
    // Người dùng tạo lại (B6 sẽ làm bằng transaction): count 1, chờ, kèm người bấm.
    await t.db
      .update(weeklyReports)
      .set({
        status: 'pending',
        regenerateCount: 1,
        requestedTrigger: 'manual',
        requestedBy: s.owner.id,
      })
      .where(eq(weeklyReports.id, s.report.id));
    const bad = new FakeReportWriter({ permanentFailure: true });
    const err = await service(bad)
      .generate(s.job(1))
      .catch((e: unknown) => e);
    const failed = await service(bad).fail(s.job(1), 'Không tạo được báo cáo.');
    const r = await row(s.report.id);
    expect(err).toBeInstanceOf(PermanentReportError);
    expect((err as PermanentReportError).cause).toBeInstanceOf(LlmPermanentError);
    expect([failed, r.status, r.lastError, r.currentVersion, r.regenerateCount]).toEqual([
      true,
      'failed',
      'Không tạo được báo cáo.',
      1, // bản v1 vẫn là bản hiển thị
      1, // không tính thêm vào quota
    ]);
    expect((await versions(s.report.id)).map((v) => v.version)).toEqual([1]);
  });

  it('tạo lại: version 2 ghi trigger=manual + người bấm, bản v1 còn nguyên', async () => {
    const s = await scenario(2);
    await service(new FakeReportWriter()).generate(s.job());
    await t.db
      .update(weeklyReports)
      .set({
        status: 'pending',
        regenerateCount: 1,
        requestedTrigger: 'manual',
        requestedBy: s.owner.id,
      })
      .where(eq(weeklyReports.id, s.report.id));
    const outcome = await service(new FakeReportWriter()).generate(s.job(1));
    const vs = await versions(s.report.id);
    expect(outcome).toBe('completed');
    expect(vs.map((v) => [v.version, v.trigger, v.triggeredBy])).toEqual([
      [1, 'scheduled', null],
      [2, 'manual', s.owner.id],
    ]);
    expect((await row(s.report.id)).currentVersion).toBe(2);
  });

  // Đột biến: bỏ kiểm `generation_token` ở `completeGenerated` → worker cũ "sống dậy" ghi đè.
  it('worker mất lease (hết hạn, worker khác đã nhận và xong) → khi nó tỉnh dậy KHÔNG ghi gì', async () => {
    const s = await scenario(3);
    const slow = new GatedWriter('chậm');
    const slowRun = service(slow).generate(s.job());
    await slow.started.promise; // worker chậm đã nhận việc và đang ở LLM
    // Lease hết hạn (worker "đơ" / bị tạm dừng): worker khác nhận và hoàn tất.
    await t.db
      .update(weeklyReports)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(weeklyReports.id, s.report.id));
    const fast = await service(new FakeReportWriter()).generate(s.job());
    slow.release(); // worker chậm trả lời xong, thử ghi
    const slowOutcome = await slowRun;

    const vs = await versions(s.report.id);
    expect([
      fast,
      slowOutcome,
      vs.length,
      vs[0]?.model,
      (await row(s.report.id)).currentVersion,
    ]).toEqual([
      'completed',
      'ignored',
      1,
      'fake', // bản của worker NHANH, không bị ghi đè hay nhân đôi
      1,
    ]);
  });

  it('worker chết (lease hết hạn, không ai nhả) → job sau nhận lại được', async () => {
    const s = await scenario(2, {
      status: 'generating',
      generationToken: crypto.randomUUID(),
      leaseUntil: new Date(Date.now() - 60_000),
    });
    expect(await service(new FakeReportWriter()).generate(s.job())).toBe('completed');
  });

  it('lease còn hạn của worker khác → ignored (không giành việc đang chạy)', async () => {
    const s = await scenario(2, {
      status: 'generating',
      generationToken: crypto.randomUUID(),
      leaseUntil: new Date(Date.now() + 600_000),
    });
    const writer = new FakeReportWriter();
    expect([await service(writer).generate(s.job()), writer.calls]).toEqual(['ignored', 0]);
  });

  it('job của lần tạo CŨ (generation lệch) → ignored; `fail()` của lần cũ không đè lần tạo lại', async () => {
    const s = await scenario(2, { regenerateCount: 1 }); // đã tạo lại một lần
    const writer = new FakeReportWriter();
    const stale = await service(writer).generate(s.job(0));
    const staleFail = await service(writer).fail(s.job(0), 'lỗi của lần cũ');
    const r = await row(s.report.id);
    expect([stale, staleFail, writer.calls, r.status, r.lastError]).toEqual([
      'ignored',
      false,
      0,
      'pending',
      null,
    ]);
  });

  it('kênh đã bị xoá (cascade xoá báo cáo) → ignored, không ném', async () => {
    const s = await scenario(2);
    await t.db.delete(channels).where(eq(channels.id, s.channel.id));
    expect(await service(new FakeReportWriter()).generate(s.job())).toBe('ignored');
  });

  it('vượt trần meeting → chỉ meeting MỚI NHẤT vào prompt và snapshot; truncated=true', async () => {
    const s = await scenario(4);
    const writer = new FakeReportWriter();
    await service(writer, { maxMeetings: 2 }).generate(s.job());
    const [v] = await versions(s.report.id);
    expect([writer.lastInput?.meetings.map((m) => m.id), v?.meetingIds, v?.truncated]).toEqual([
      s.meetingIds.slice(2),
      s.meetingIds.slice(2),
      true,
    ]);
  });

  it('meeting gỡ share SAU khi báo cáo xong không đổi bản đã lưu; tạo lại tính lại từ đầu', async () => {
    const s = await scenario(3);
    await service(new FakeReportWriter()).generate(s.job());
    await t.db.execute(sql`delete from meeting_shares where meeting_id = ${s.meetingIds[0]!}`);
    const [v1] = await versions(s.report.id);
    expect(v1?.meetingIds).toEqual(s.meetingIds); // bản cũ giữ nguyên snapshot
    await t.db
      .update(weeklyReports)
      .set({ status: 'pending', regenerateCount: 1 })
      .where(eq(weeklyReports.id, s.report.id));
    await service(new FakeReportWriter()).generate(s.job(1));
    const vs = await versions(s.report.id);
    expect(vs[1]?.meetingIds).toEqual(s.meetingIds.slice(1)); // tính lại: không còn meeting đã gỡ
  });

  describe('thông báo report.ready (B7, Q7)', () => {
    const notificationsOf = (userId: string) =>
      t.db.select().from(notifications).where(eq(notifications.userId, userId));

    it('bản THEO LỊCH: không ghi thông báo trong transaction; xếp đúng MỘT fan-out cho phiên bản vừa ghi', async () => {
      const s = await scenario(2);
      fanoutCalls.length = 0;
      await service(new FakeReportWriter()).generate(s.job());
      expect(fanoutCalls).toEqual([{ reportId: s.report.id, version: 1 }]);
      expect(await notificationsOf(s.owner.id)).toHaveLength(0); // cả kênh nhận qua fan-out, không phải ở đây
    });

    // Đột biến: ghi thông báo ngoài transaction / quên điều kiện manual → người khác cũng nhận.
    it('bản TẠO LẠI THỦ CÔNG: CHỈ người bấm nhận, ghi trong transaction, dedupe theo phiên bản; không xếp fan-out', async () => {
      const s = await scenario(2);
      const clicker = await insertUser(t.db);
      await addMember(t.db, s.org.id, clicker.id); // người bấm là thành viên tổ chức
      await t.db
        .update(weeklyReports)
        .set({ requestedTrigger: 'manual', requestedBy: clicker.id })
        .where(eq(weeklyReports.id, s.report.id));
      fanoutCalls.length = 0;
      emitted.length = 0;
      await service(new FakeReportWriter()).generate(s.job());

      const [mine] = await notificationsOf(clicker.id);
      expect(fanoutCalls).toEqual([]);
      expect(mine).toMatchObject({
        type: 'report.ready',
        orgId: s.org.id,
        dedupeKey: `report-ready.${s.report.id}.v1`,
        payload: {
          reportId: s.report.id,
          channelId: s.channel.id,
          channelName: 'Kinh doanh',
          weekStart: WEEK,
          version: 1,
        },
      });
      expect(await notificationsOf(s.owner.id)).toHaveLength(0);
      expect(emitted).toEqual([{ rooms: [`user:${clicker.id}`], event: 'notification.created' }]);
    });

    // Đột biến: điều kiện chỉ còn `requestedBy` (bỏ `trigger === 'manual'`) → bản theo lịch cũng thông báo riêng.
    it('bản THEO LỊCH mà `requested_by` còn sót → vẫn fan-out cả kênh, KHÔNG thông báo riêng', async () => {
      const s = await scenario(2);
      const leftover = await insertUser(t.db);
      await addMember(t.db, s.org.id, leftover.id);
      await t.db
        .update(weeklyReports)
        .set({ requestedTrigger: 'scheduled', requestedBy: leftover.id })
        .where(eq(weeklyReports.id, s.report.id));
      fanoutCalls.length = 0;
      await service(new FakeReportWriter()).generate(s.job());
      expect([fanoutCalls.length, (await notificationsOf(leftover.id)).length]).toEqual([1, 0]);
    });

    // Đột biến: bỏ `lockOrgMember` → INSERT thông báo lỗi 23503, rollback cả phiên bản, retry mãi.
    it('người bấm đã RỜI tổ chức trước khi báo cáo xong → báo cáo VẪN hoàn tất, chỉ không thông báo', async () => {
      const s = await scenario(2);
      const gone = await insertUser(t.db); // không phải thành viên org
      await t.db
        .update(weeklyReports)
        .set({ requestedTrigger: 'manual', requestedBy: gone.id })
        .where(eq(weeklyReports.id, s.report.id));
      emitted.length = 0;
      const outcome = await service(new FakeReportWriter()).generate(s.job());
      expect([
        outcome,
        (await row(s.report.id)).status,
        (await versions(s.report.id)).length,
      ]).toEqual(['completed', 'completed', 1]);
      expect([await notificationsOf(gone.id), emitted]).toEqual([[], []]);
    });

    it('tạo lại thủ công mà người bấm đã bị xoá (requested_by NULL) → hoàn tất, không thông báo, không lỗi', async () => {
      const s = await scenario(2, { requestedTrigger: 'manual', requestedBy: null });
      fanoutCalls.length = 0;
      expect(await service(new FakeReportWriter()).generate(s.job())).toBe('completed');
      expect(fanoutCalls).toEqual([]);
    });

    it('báo cáo `skipped` / job bị bỏ qua / mất lease → KHÔNG thông báo, KHÔNG fan-out', async () => {
      const skipped = await scenario(1);
      const done = await scenario(2);
      await service(new FakeReportWriter()).generate(done.job());
      fanoutCalls.length = 0;
      emitted.length = 0;
      await service(new FakeReportWriter()).generate(skipped.job()); // skipped
      await service(new FakeReportWriter()).generate(done.job()); // job trùng → ignored
      expect([fanoutCalls, emitted]).toEqual([[], []]);
    });
  });
});
