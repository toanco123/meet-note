import { describe, expect, it } from 'vitest';
import {
  chunkLines,
  formatTranscript,
  parseSummaryContent,
} from '../../../../src/infra/llm/summary-format.js';

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
    expect(parseSummaryContent(raw)).toBeNull();
  });

  it('parseSummaryContent nhận owner / due null', () => {
    const value = {
      overview: 'x',
      keyPoints: [],
      decisions: [],
      actionItems: [{ owner: null, task: 't', due: null }],
    };
    expect(parseSummaryContent(JSON.stringify(value))).toEqual(value);
  });
});
