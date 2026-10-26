import { describe, expect, it } from 'vitest';
import {
  addDays,
  isWeekStart,
  localDate,
  mondayOf,
  previousWeekStart,
} from '../../../../src/modules/reports/report-week.js';

describe('previousWeekStart (tuần trước, theo giờ VN)', () => {
  it.each([
    // [mô tả, firedAt (UTC), tuần kỳ vọng]
    ['Thứ Hai 08:00 VN (lịch chạy)', '2026-10-12T01:00:00Z', '2026-10-05'],
    ['Thứ Hai 00:00:00 VN đúng', '2026-10-11T17:00:00Z', '2026-10-05'],
    [
      'Chủ nhật 23:59:59,999 VN — vẫn là tuần cũ, báo cáo tuần trước nữa',
      '2026-10-11T16:59:59.999Z',
      '2026-09-28',
    ],
    ['UTC còn là Chủ nhật nhưng VN đã Thứ Hai 03:00', '2026-10-11T20:00:00Z', '2026-10-05'],
    ['UTC Thứ Hai 00:00 = 07:00 VN', '2026-10-12T00:00:00Z', '2026-10-05'],
    ['tick trễ tới Thứ Ba', '2026-10-13T10:00:00Z', '2026-10-05'],
    ['tick trễ tới Chủ nhật cuối tuần', '2026-10-18T16:00:00Z', '2026-10-05'],
    ['qua năm (Thứ Hai đầu 2026)', '2026-01-05T01:00:00Z', '2025-12-29'],
    ['qua năm (Thứ Hai đầu 2027)', '2027-01-04T01:00:00Z', '2026-12-28'],
    ['năm nhuận', '2024-03-04T01:00:00Z', '2024-02-26'],
  ])('%s', (_label, firedAt, expected) => {
    expect(previousWeekStart(new Date(firedAt))).toBe(expected);
  });

  it('múi giờ có chuyển giờ mùa hè: cộng ngày lịch, không cộng 24 × 3600 s', () => {
    // New York chuyển giờ 2026-03-08; Thứ Hai kế tiếp 2026-03-09. Tuần trước = 2026-03-02.
    expect(previousWeekStart(new Date('2026-03-09T12:00:00Z'), 'America/New_York')).toBe(
      '2026-03-02',
    );
    // Sau ngày kết thúc giờ mùa hè (2026-11-01).
    expect(previousWeekStart(new Date('2026-11-02T14:00:00Z'), 'America/New_York')).toBe(
      '2026-10-26',
    );
  });
});

describe('localDate', () => {
  it('ngày lịch phụ thuộc múi giờ', () => {
    const at = new Date('2026-10-11T20:00:00Z');
    expect([localDate(at, 'UTC'), localDate(at), localDate(at, 'America/Los_Angeles')]).toEqual([
      '2026-10-11',
      '2026-10-12',
      '2026-10-11',
    ]);
  });
});

describe('mondayOf / addDays / isWeekStart', () => {
  it.each([
    ['2026-10-05', '2026-10-05'], // Thứ Hai
    ['2026-10-06', '2026-10-05'],
    ['2026-10-11', '2026-10-05'], // Chủ nhật lùi 6 ngày
    ['2026-01-01', '2025-12-29'], // Thứ Năm, sang năm trước
    ['2024-02-29', '2024-02-26'],
  ])('mondayOf(%s) = %s', (date, monday) => {
    expect(mondayOf(date)).toBe(monday);
  });

  it.each([
    ['2026-10-05', -7, '2026-09-28'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2024-02-28', 2, '2024-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
  ])('addDays(%s, %i) = %s', (date, n, expected) => {
    expect(addDays(date, n)).toBe(expected);
  });

  it.each([
    ['2026-10-05', true],
    ['2024-02-26', true],
    ['2026-10-06', false], // Thứ Ba
    ['2026-10-04', false], // Chủ nhật
    ['2026-02-30', false], // không phải ngày thật
    ['2026-13-01', false],
    ['2026-10-5', false],
    ['2026-10-05T00:00:00Z', false],
    ['', false],
    ['abc', false],
  ])('isWeekStart(%j) = %s', (value, expected) => {
    expect(isWeekStart(value)).toBe(expected);
  });

  it('ngày không hợp lệ → ném, không âm thầm cuốn sang tháng sau', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow('Ngày không hợp lệ');
    expect(() => mondayOf('nope')).toThrow('Ngày không hợp lệ');
  });
});
