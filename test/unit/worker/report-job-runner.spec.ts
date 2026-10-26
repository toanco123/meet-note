import { describe, expect, it } from 'vitest';
import { scheduledAt } from '../../../src/worker/report-job-runner.js';
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
