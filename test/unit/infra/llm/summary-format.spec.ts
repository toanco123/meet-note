import { describe, expect, it } from 'vitest';
import {
  chunkLines,
  describeMeetingDate,
  formatTranscript,
  parseSummaryContent,
  PROMPT_VERSION,
  resolveDueDate,
  SUMMARY_SCHEMA,
  SYSTEM_PROMPT,
} from '../../../../src/infra/llm/summary-format.js';

const MEETING_DATE = '2026-10-27'; // Thứ Ba

describe('summary-format (hàm thuần)', () => {
  it('formatTranscript: [mm:ss], có giờ thì [h:mm:ss]', () => {
    expect(
      formatTranscript([
        { startMs: 0, text: 'a' },
        { startMs: 65_400, text: 'b' },
        { startMs: 3_725_000, text: 'c' },
      ]),
    ).toEqual(['[00:00] a', '[01:05] b', '[1:02:05] c']);
  });

  it('chunkLines: không cắt giữa dòng, mỗi phần ≤ maxChars, dòng quá dài đứng riêng, không mất dòng', () => {
    const lines = ['1234', '5678', '9', 'abcdefghijk', 'xy'];
    const chunks = chunkLines(lines, 10);
    expect(chunks).toEqual(['1234\n5678', '9', 'abcdefghijk', 'xy']);
    expect(chunks.join('\n').split('\n')).toEqual(lines);
  });

  it.each([
    ['không phải JSON', '{'],
    [
      'overview rỗng',
      JSON.stringify({ overview: ' ', keyPoints: [], decisions: [], actionItems: [] }),
    ],
    [
      'keyPoints không phải mảng chuỗi',
      JSON.stringify({ overview: 'x', keyPoints: [1], decisions: [], actionItems: [] }),
    ],
    [
      'actionItem thiếu task',
      JSON.stringify({
        overview: 'x',
        keyPoints: [],
        decisions: [],
        actionItems: [{ owner: null, due: null }],
      }),
    ],
  ])('parseSummaryContent từ chối: %s', (_label, raw) => {
    expect(parseSummaryContent(raw, MEETING_DATE)).toBeNull();
  });

  it('parseSummaryContent nhận owner / due / dueDate null', () => {
    const value = {
      overview: 'x',
      keyPoints: [],
      decisions: [],
      actionItems: [{ owner: null, task: 't', due: null, dueDate: null }],
    };
    expect(parseSummaryContent(JSON.stringify(value), MEETING_DATE)).toEqual(value);
  });

  it('thiếu dueDate (model bỏ sót / tóm tắt cũ) → dueDate null, phần còn lại nguyên', () => {
    const raw = JSON.stringify({
      overview: 'x',
      keyPoints: [],
      decisions: [],
      actionItems: [{ owner: 'Bình', task: 't', due: 'thứ sáu' }],
    });
    expect(parseSummaryContent(raw, MEETING_DATE)?.actionItems).toEqual([
      { owner: 'Bình', task: 't', due: 'thứ sáu', dueDate: null },
    ]);
  });

  it('dueDate sai chỉ mất MỘT trường: bản tóm tắt vẫn hợp lệ, các việc khác giữ hạn', () => {
    const item = (task: string, dueDate: unknown) => ({ owner: null, task, due: 'x', dueDate });
    const raw = JSON.stringify({
      overview: 'x',
      keyPoints: [],
      decisions: [],
      actionItems: [item('đúng', '2026-10-30'), item('năm sai', '2024-10-30'), item('rác', 'sớm')],
    });
    expect(parseSummaryContent(raw, MEETING_DATE)?.actionItems.map((i) => i.dueDate)).toEqual([
      '2026-10-30',
      null,
      null,
    ]);
  });
});

describe('resolveDueDate (kiểm lại hạn model quy ra, theo ngày họp)', () => {
  it.each([
    ['cùng ngày họp', '2026-10-27', '2026-10-27'],
    ['một ngày trước (biên dưới)', '2026-10-26', '2026-10-26'],
    ['hai ngày trước (ngoài biên)', '2026-10-25', null],
    ['hạn thường gặp', '2026-10-30', '2026-10-30'],
    ['đúng 730 ngày sau (biên trên)', '2028-10-26', '2028-10-26'],
    ['731 ngày sau (ngoài biên)', '2028-10-27', null],
    ['năm sai (model quy theo năm cũ)', '2025-10-30', null],
    ['không phải ngày thật 30/2', '2026-02-30', null],
    ['tháng 13', '2026-13-01', null],
    ['sai dạng DD/MM/YYYY', '30/10/2026', null],
    ['kèm giờ', '2026-10-30T00:00:00Z', null],
    ['chuỗi chữ', 'thứ sáu', null],
    ['chuỗi rỗng', '', null],
  ])('%s: %s → %s', (_label, value, expected) => {
    expect(resolveDueDate(value, MEETING_DATE)).toBe(expected);
  });

  it.each([[null], [undefined], [20261030], [{}], [['2026-10-30']]])(
    'không phải chuỗi (%j) → null',
    (value) => {
      expect(resolveDueDate(value, MEETING_DATE)).toBeNull();
    },
  );

  it('ngày họp hỏng → null (không đoán), kể cả khi hạn hợp lệ', () => {
    expect(resolveDueDate('2026-10-30', 'không-phải-ngày')).toBeNull();
  });

  it('biên qua tháng / năm / năm nhuận tính theo NGÀY LỊCH', () => {
    expect(resolveDueDate('2027-01-01', '2026-12-31')).toBe('2027-01-01');
    expect(resolveDueDate('2026-12-30', '2026-12-31')).toBe('2026-12-30');
    expect(resolveDueDate('2028-02-29', '2028-02-28')).toBe('2028-02-29'); // 2028 nhuận
    expect(resolveDueDate('2027-02-29', '2027-02-28')).toBeNull(); // 2027 không nhuận
  });
});

describe('describeMeetingDate / schema / prompt (M12 Q2)', () => {
  it.each([
    ['2026-10-27', 'Thứ ba'],
    ['2026-10-25', 'Chủ nhật'],
    ['2026-10-26', 'Thứ hai'],
    ['2026-10-31', 'Thứ bảy'],
  ])('%s → kèm thứ %s (model không phải tự tính thứ từ ngày ISO)', (date, weekday) => {
    expect(describeMeetingDate(date)).toBe(`Ngày họp: ${weekday}, ${date} (giờ Việt Nam).`);
  });

  it('ngày hỏng → vẫn trả câu, không ném lỗi', () => {
    expect(describeMeetingDate('hỏng')).toBe('Ngày họp: hỏng (giờ Việt Nam).');
  });

  it('phiên bản prompt v2; schema yêu cầu dueDate (chuỗi hoặc null); prompt dặn không đoán hạn mơ hồ', () => {
    expect(PROMPT_VERSION).toBe('v2');
    const item = SUMMARY_SCHEMA.properties.actionItems.items;
    expect(item.required).toContain('dueDate');
    expect(item.properties.dueDate.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(SYSTEM_PROMPT).toContain('dueDate');
    expect(SYSTEM_PROMPT).toMatch(/không đoán/);
  });
});
