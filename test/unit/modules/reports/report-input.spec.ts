import { describe, expect, it } from 'vitest';
import {
  buildReportInput,
  MAX_OVERDUE_ACTION_ITEMS,
  MAX_REPORT_MEETINGS,
  selectMeetings,
  selectOverdueItems,
} from '../../../../src/modules/reports/report-input.js';
import type {
  OverdueActionItem,
  ReportMeeting,
} from '../../../../src/modules/reports/reports.types.js';

const meeting = (n: number): ReportMeeting => ({
  id: `m${n}`,
  title: `Họp ${n}`,
  recordedAt: new Date(Date.UTC(2026, 9, 5, n)),
  summary: { overview: `Tóm tắt ${n}`, keyPoints: [], decisions: [], actionItems: [] },
});
const many = (n: number) => Array.from({ length: n }, (_, i) => meeting(i));

describe('selectMeetings', () => {
  it.each([
    [0, 0, false],
    [1, 1, false],
    [MAX_REPORT_MEETINGS - 1, MAX_REPORT_MEETINGS - 1, false],
    [MAX_REPORT_MEETINGS, MAX_REPORT_MEETINGS, false], // đúng trần: chưa cắt
    [MAX_REPORT_MEETINGS + 1, MAX_REPORT_MEETINGS, true], // vượt 1: cắt 1
    [MAX_REPORT_MEETINGS * 3, MAX_REPORT_MEETINGS, true],
  ])('%i meeting → giữ %i, truncated=%s', (n, kept, truncated) => {
    const result = selectMeetings(many(n));
    expect([result.included.length, result.truncated]).toEqual([kept, truncated]);
  });

  it('vượt trần: giữ meeting MỚI NHẤT, vẫn theo thứ tự cũ → mới', () => {
    const result = selectMeetings(many(7), 3);
    expect(result.included.map((m) => m.id)).toEqual(['m4', 'm5', 'm6']);
    expect(result.truncated).toBe(true);
  });
});

describe('buildReportInput', () => {
  it('tuần = Thứ Hai → Chủ nhật; recordedAt ISO; giữ thứ tự và tóm tắt', () => {
    const input = buildReportInput('Kinh doanh', '2026-12-28', [meeting(1), meeting(2)]);
    expect([input.channelName, input.weekStart, input.weekEnd]).toEqual([
      'Kinh doanh',
      '2026-12-28',
      '2027-01-03', // qua năm
    ]);
    expect(input.meetings.map((m) => [m.id, m.recordedAt, m.summary.overview])).toEqual([
      ['m1', '2026-10-05T01:00:00.000Z', 'Tóm tắt 1'],
      ['m2', '2026-10-05T02:00:00.000Z', 'Tóm tắt 2'],
    ]);
  });
});

describe('selectOverdueItems (M12 Q9)', () => {
  const item = (n: number): OverdueActionItem => ({
    id: `i${n}`,
    task: `Việc ${n}`,
    assignee: null,
    dueDate: '2026-10-01',
    meetingId: 'm',
    meetingTitle: 'Họp',
  });
  const rows = (n: number) => Array.from({ length: n }, (_, i) => item(i));

  it.each([
    [0, 0, false],
    [1, 1, false],
    [MAX_OVERDUE_ACTION_ITEMS - 1, MAX_OVERDUE_ACTION_ITEMS - 1, false],
    [MAX_OVERDUE_ACTION_ITEMS, MAX_OVERDUE_ACTION_ITEMS, false], // đúng trần: chưa cắt
    [MAX_OVERDUE_ACTION_ITEMS + 1, MAX_OVERDUE_ACTION_ITEMS, true], // repository lấy trần + 1: dư 1 → cắt
  ])('%i dòng → giữ %i, truncated=%s', (n, kept, truncated) => {
    const out = selectOverdueItems(rows(n));
    expect(out.items).toHaveLength(kept);
    expect(out.truncated).toBe(truncated);
  });

  it('giữ các dòng ĐẦU (hạn cũ nhất, repository đã sắp) và đúng thứ tự', () => {
    const out = selectOverdueItems(rows(5), 3);
    expect(out.items.map((i) => i.id)).toEqual(['i0', 'i1', 'i2']);
    expect(out.truncated).toBe(true);
  });

  it('trần mặc định là 20', () => {
    expect(MAX_OVERDUE_ACTION_ITEMS).toBe(20);
  });
});
