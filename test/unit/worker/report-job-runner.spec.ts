import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { PermanentReportError } from '../../../src/modules/reports/report.errors.js';
import { ReportJobRunner, scheduledAt } from '../../../src/worker/report-job-runner.js';
import { previousWeekStart } from '../../../src/modules/reports/report-week.js';

describe('scheduledAt (mốc lịch BẮN của job Job Scheduler)', () => {
  it('= thời điểm tạo job + delay tới mốc cron; không có delay → chính thời điểm tạo', () => {
    expect(scheduledAt({ timestamp: 1_000, delay: 500 }).getTime()).toBe(1_500);
    expect(scheduledAt({ timestamp: 1_000, delay: 0 }).getTime()).toBe(1_000);
    expect(
      scheduledAt({ timestamp: 1_000 } as { timestamp: number; delay: number }).getTime(),
    ).toBe(1_000);
  });

  it('tuần suy từ mốc BẮN, không từ lúc xử lý: job tạo Thứ Hai trước, bắn Thứ Hai sau 08:00 VN', () => {
    // Tạo ngay sau lần bắn trước (Thứ Hai 2026-10-05 08:00 VN), bắn tuần sau (2026-10-12 08:00 VN).
    const created = Date.parse('2026-10-05T01:00:05Z');
    const fire = Date.parse('2026-10-12T01:00:00Z');
    const job = { timestamp: created, delay: fire - created };
    // Tính theo timestamp (lúc TẠO) sẽ ra tuần 09-28 — sai một tuần.
    expect(previousWeekStart(new Date(created))).toBe('2026-09-28');
    expect(previousWeekStart(scheduledAt(job))).toBe('2026-10-05');
  });
});

describe('ReportJobRunner (tắt êm, lỗi vĩnh viễn, hết lượt)', () => {
  const data = { reportId: 'r1', generation: 2, requestId: 'req' } as never;
  const makeJob = (extra: Record<string, unknown> = {}) =>
    ({
      id: 'weekly-report.generate.r1.g2',
      name: 'weekly-report.generate',
      data,
      attemptsMade: 1,
      opts: { attempts: 5 },
      moveToDelayed: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...extra,
    }) as never as Job<never> & { moveToDelayed: ReturnType<typeof vi.fn<() => Promise<void>>> };

  function build(generate: (d: unknown, o: { signal: AbortSignal }) => Promise<unknown>) {
    const generation = {
      generate: vi.fn<typeof generate>(generate),
      fail: vi.fn<(d: unknown, m?: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const runner = new ReportJobRunner(
      generation as never,
      { run: vi.fn<() => Promise<void>>() } as never,
    );
    return { runner, generation };
  }

  it('job lấy về SAU khi bắt đầu tắt → delayed, KHÔNG chạy generate', async () => {
    const { runner, generation } = build(() => Promise.resolve('generated'));
    await runner.beforeApplicationShutdown();
    const job = makeJob();
    await expect(runner.runGenerate(job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(generation.generate).not.toHaveBeenCalled();
  });

  it('đang chạy mà tắt → abort signal, chờ xong, job về delayed (không đánh failed)', async () => {
    let seen: AbortSignal | undefined;
    const { runner, generation } = build(
      (_d, { signal }) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const job = makeJob();
    const running = runner.runGenerate(job, 'tok');
    const outcome = running.catch((e: unknown) => e);
    await vi.waitFor(() => expect(seen).toBeDefined());
    await runner.beforeApplicationShutdown(); // chờ tới khi job dừng hẳn
    expect(seen?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(generation.fail).not.toHaveBeenCalled();
  });

  it('lỗi vĩnh viễn → đánh failed NGAY với câu cho người dùng + UnrecoverableError', async () => {
    const { runner, generation } = build(() =>
      Promise.reject(new PermanentReportError('Mô hình từ chối.')),
    );
    await expect(runner.runGenerate(makeJob(), 'tok')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(generation.fail).toHaveBeenCalledWith(data, 'Mô hình từ chối.');
  });

  it('lỗi tạm → ném nguyên (BullMQ retry), chưa đánh failed', async () => {
    const boom = new Error('503');
    const { runner, generation } = build(() => Promise.reject(boom));
    await expect(runner.runGenerate(makeJob(), 'tok')).rejects.toBe(boom);
    expect(generation.fail).not.toHaveBeenCalled();
  });

  it.each([
    ['còn lượt', 3, 'Error', 0],
    ['hết lượt', 5, 'Error', 1],
    ['lỗi vĩnh viễn (đã đánh failed rồi)', 5, 'UnrecoverableError', 0],
  ])('sự kiện failed — %s → fail() %i lần', async (_n, attemptsMade, name, calls) => {
    const { runner, generation } = build(() => Promise.resolve());
    const error = Object.assign(new Error('x'), { name });
    await runner.onGenerateFailed(makeJob({ attemptsMade }), error);
    expect(generation.fail).toHaveBeenCalledTimes(calls);
  });

  it('sự kiện failed không có job → bỏ qua', async () => {
    const { runner, generation } = build(() => Promise.resolve());
    await runner.onGenerateFailed(undefined, new Error('x'));
    expect(generation.fail).not.toHaveBeenCalled();
  });

  it('tick với weekStart không phải Thứ Hai → UnrecoverableError, không chạy tick', async () => {
    const tick = { run: vi.fn<() => Promise<void>>() };
    const runner = new ReportJobRunner({} as never, tick as never);
    const job = { data: { weekStart: '2026-10-06' }, timestamp: 0, delay: 0 } as never;
    await expect(runner.runTick(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(tick.run).not.toHaveBeenCalled();
  });
});
