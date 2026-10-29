import { describe, expect, it } from 'vitest';
import { AppException } from '../../../../src/common/errors/app.exception.js';
import type { OrgDailyStatsRow } from '../../../../src/infra/database/schema/index.js';
import {
  buildSeries,
  buildTotals,
  enumerateDays,
  failureRate,
  MAX_RANGE_DAYS,
  resolveRange,
  toMinutes,
} from '../../../../src/modules/dashboard/dashboard-range.js';

const TODAY = '2026-10-29'; // Thứ Năm

const status = (fn: () => unknown): { status: number; fields: string[] } | 'ok' => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppException) {
      const body = e.getResponse() as { details?: Array<{ field: string }> };
      return { status: e.getStatus(), fields: (body.details ?? []).map((d) => d.field) };
    }
    throw e;
  }
  return 'ok';
};

const row = (day: string, over: Partial<OrgDailyStatsRow> = {}): OrgDailyStatsRow => ({
  orgId: 'o',
  day,
  meetingsTotal: 0,
  meetingsCompleted: 0,
  meetingsFailed: 0,
  recordedMs: 0,
  transcribedMs: 0,
  computedAt: new Date('2026-10-29T01:00:00Z'),
  ...over,
});

describe('resolveRange', () => {
  it('mặc định: 30 ngày gần nhất tới hôm nay (gồm hôm nay)', () => {
    expect(resolveRange(undefined, undefined, TODAY)).toEqual({ from: '2026-09-30', to: TODAY });
    expect(enumerateDays(resolveRange(undefined, undefined, TODAY))).toHaveLength(30);
  });

  it('chỉ có `to` → lùi 30 ngày từ `to`; chỉ có `from` → tới hôm nay', () => {
    expect(resolveRange(undefined, '2026-10-20', TODAY)).toEqual({
      from: '2026-09-21',
      to: '2026-10-20',
    });
    expect(resolveRange('2026-10-01', undefined, TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
  });

  it('một ngày (from = to) hợp lệ; `to` ở tương lai hợp lệ', () => {
    expect(resolveRange('2026-10-29', '2026-10-29', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(resolveRange('2026-10-29', '2026-11-05', TODAY).to).toBe('2026-11-05');
  });

  // Đột biến: `>` → `>=` ở kiểm 92 ngày (hoặc ngược lại) lệch đúng 1.
  it.each([
    ['đúng 92 ngày', '2026-07-30', '2026-10-29', 'ok'],
    ['93 ngày', '2026-07-29', '2026-10-29', 400],
    ['đúng 92 ngày, qua năm và tháng 2 (28 ngày)', '2025-12-01', '2026-03-02', 'ok'],
    ['93 ngày, qua năm', '2025-12-01', '2026-03-03', 400],
  ])('độ dài: %s', (_n, from, to, expected) => {
    const r = status(() => resolveRange(from, to, to));
    expect(r === 'ok' ? 'ok' : r.status).toBe(expected);
  });

  it('cửa sổ xem được: from phải trong 92 ngày gần nhất tính từ hôm nay', () => {
    // hôm nay − 91 ngày là ngày xa nhất còn xem được
    expect(resolveRange('2026-07-30', '2026-07-30', TODAY).from).toBe('2026-07-30');
    expect(status(() => resolveRange('2026-07-29', '2026-07-29', TODAY))).toEqual({
      status: 400,
      fields: ['from'],
    });
  });

  it.each([
    ['from sau to', '2026-10-10', '2026-10-09', ['from']],
    ['from không có thật', '2026-02-30', '2026-10-09', ['from']],
    ['to không có thật', '2026-10-01', '2026-13-01', ['to']],
    ['sai dạng', '29/10/2026', undefined, ['from']],
    ['cả hai sai', 'x', 'y', ['from', 'to']],
  ])('400: %s', (_n, from, to, fields) => {
    expect(status(() => resolveRange(from, to, TODAY))).toEqual({ status: 400, fields });
  });

  it('MAX_RANGE_DAYS là 92', () => {
    expect(MAX_RANGE_DAYS).toBe(92);
  });
});

describe('enumerateDays', () => {
  it('qua tháng và năm, gồm hai đầu', () => {
    expect(enumerateDays({ from: '2026-12-30', to: '2027-01-02' })).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(enumerateDays({ from: '2026-10-05', to: '2026-10-05' })).toEqual(['2026-10-05']);
  });
});

describe('buildSeries', () => {
  const range = { from: '2026-10-05', to: '2026-10-11' }; // đúng một tuần Thứ Hai → CN

  // Đột biến: bỏ điền ngày trống → mất điểm.
  it('theo ngày: ĐIỀN ĐỦ mọi ngày, ngày không có dòng là 0', () => {
    const series = buildSeries(
      [
        row('2026-10-06', {
          meetingsTotal: 2,
          meetingsCompleted: 1,
          meetingsFailed: 1,
          recordedMs: 120_000,
          transcribedMs: 60_000,
        }),
      ],
      range,
      'day',
    );
    expect(series.map((p) => p.period)).toEqual(enumerateDays(range));
    expect(series[1]).toEqual({
      period: '2026-10-06',
      meetings: 2,
      completed: 1,
      failed: 1,
      recordedMinutes: 2,
      transcribedMinutes: 1,
    });
    expect(series.filter((p) => p.meetings === 0)).toHaveLength(6);
  });

  it('theo tuần: gom theo Thứ Hai, nhãn là Thứ Hai; tuần đầu / cuối chỉ gồm phần trong khoảng', () => {
    // 2026-10-01 là Thứ Năm → tuần bắt đầu 09-28; khoảng chạm 3 tuần
    const r = { from: '2026-10-01', to: '2026-10-14' };
    const series = buildSeries(
      [
        row('2026-10-01', { meetingsTotal: 1 }),
        row('2026-10-04', { meetingsTotal: 2 }), // CN: vẫn tuần 09-28
        row('2026-10-05', { meetingsTotal: 4 }), // Thứ Hai: tuần mới
        row('2026-10-12', { meetingsTotal: 8 }),
      ],
      r,
      'week',
    );
    expect(series.map((p) => [p.period, p.meetings])).toEqual([
      ['2026-09-28', 3],
      ['2026-10-05', 4],
      ['2026-10-12', 8],
    ]);
  });

  it('tổng theo tuần KHỚP tổng theo ngày (cộng mili giây rồi mới đổi phút)', () => {
    const rows = ['05', '06', '07'].map((d) =>
      row(`2026-10-${d}`, { recordedMs: 40_000, meetingsTotal: 1 }),
    );
    const [week] = buildSeries(rows, range, 'week');
    const days = buildSeries(rows, range, 'day');
    // 3 × 40 s = 120 s = 2 phút; cộng các ngày đã làm tròn (3 × round(0.67)=3) sẽ ra 3 — sai
    expect(week!.recordedMinutes).toBe(2);
    expect(days.reduce((s, p) => s + p.recordedMinutes, 0)).toBe(3);
    expect(buildTotals(rows).recordedMinutes).toBe(2);
  });

  it('dòng ngoài khoảng bị bỏ qua (không lọt vào tổng)', () => {
    const series = buildSeries([row('2026-09-01', { meetingsTotal: 99 })], range, 'day');
    expect(series.every((p) => p.meetings === 0)).toBe(true);
  });
});

describe('buildTotals / failureRate / toMinutes', () => {
  it('cộng mọi dòng; tỉ lệ lỗi chỉ tính meeting đã kết thúc', () => {
    const totals = buildTotals([
      row('2026-10-05', {
        meetingsTotal: 6,
        meetingsCompleted: 3,
        meetingsFailed: 1,
        recordedMs: 600_000,
        transcribedMs: 300_000,
      }),
      row('2026-10-06', {
        meetingsTotal: 2,
        meetingsCompleted: 0,
        meetingsFailed: 0,
        recordedMs: 0,
      }), // đang xử lý
    ]);
    expect(totals).toEqual({
      meetings: 8,
      completed: 3,
      failed: 1,
      failureRate: 0.25, // 1 / (3 + 1), KHÔNG phải 1 / 8
      recordedMinutes: 10,
      transcribedMinutes: 5,
    });
  });

  it('không có dòng nào → mọi số 0 và failureRate null', () => {
    expect(buildTotals([])).toEqual({
      meetings: 0,
      completed: 0,
      failed: 0,
      failureRate: null,
      recordedMinutes: 0,
      transcribedMinutes: 0,
    });
  });

  it.each([
    [0, 0, null],
    [5, 0, 0], // có kết thúc, không lỗi: 0 (khác null)
    [0, 4, 1],
    [1, 2, 0.6667],
    [2, 1, 0.3333],
  ])('failureRate(%i completed, %i failed) = %s', (c, f, expected) => {
    expect(failureRate(c, f)).toBe(expected);
  });

  it.each([
    [0, 0],
    [29_999, 0],
    [30_000, 1],
    [89_999, 1],
    [90_000, 2],
    [3_600_000, 60],
  ])('toMinutes(%i ms) = %i', (ms, min) => {
    expect(toMinutes(ms)).toBe(min);
  });
});
