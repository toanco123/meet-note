import { describe, expect, it } from 'vitest';
import {
  formatSrt,
  formatTimestamp,
  formatVtt,
  normalizeCueText,
} from '../../../../src/modules/transcripts/transcript-formats.js';
import type { SubtitleCue } from '../../../../src/modules/transcripts/transcripts.types.js';

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}
const cue = (startMs: number, endMs: number, text: string): SubtitleCue => ({
  startMs,
  endMs,
  text,
});

describe('formatTimestamp', () => {
  it.each([
    [0, ',', '00:00:00,000'],
    [999, ',', '00:00:00,999'],
    [1_000, ',', '00:00:01,000'],
    [61_001, '.', '00:01:01.001'],
    [3_599_999, '.', '00:59:59.999'],
    [3_600_000, ',', '01:00:00,000'],
    [14_400_000, '.', '04:00:00.000'], // 4 giờ — trần của pipeline
    [360_000_000, ',', '100:00:00,000'], // không cắt giờ ở 2 chữ số
    [1_234.9, ',', '00:00:01,234'], // phần lẻ bị cắt, không làm tròn lên
    [-5, ',', '00:00:00,000'],
  ] as const)('%s ms (%s) → %s', (ms, sep, expected) => {
    expect(formatTimestamp(ms, sep)).toBe(expected);
  });
});

describe('normalizeCueText', () => {
  it.each([
    ['Xin chào', 'Xin chào'],
    ['  Xin chào  ', 'Xin chào'],
    ['dòng 1\r\ndòng 2', 'dòng 1\ndòng 2'],
    ['dòng 1\rdòng 2', 'dòng 1\ndòng 2'],
    ['dòng 1\n\n\ndòng 2', 'dòng 1\ndòng 2'], // dòng trống kết thúc cue → bỏ
    ['a\u2028b\u2029c', 'a\nb\nc'],
    ['a\u0000b\u0007c\u001Bd', 'abcd'],
    ['tab\there', 'tab\there'], // tab giữ nguyên
  ])('%j → %j', (input, expected) => {
    expect(normalizeCueText(input)).toBe(expected);
  });

  it.each(['', '   ', '\n\n', '\r\n \t \n', '\u0000'])('%j → bỏ cue', (input) => {
    expect(normalizeCueText(input)).toBeUndefined();
  });
});

describe('formatSrt', () => {
  it('đánh số từ 1, dấu phẩy ở mili giây, mỗi cue kết thúc bằng một dòng trống', async () => {
    const out = await collect(
      formatSrt([cue(0, 1_500, 'Xin chào'), cue(1_500, 3_000, 'Hôm nay họp\nkế hoạch')]),
    );
    expect(out).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nXin chào\n\n' +
        '2\n00:00:01,500 --> 00:00:03,000\nHôm nay họp\nkế hoạch\n\n',
    );
  });

  it('bỏ cue rỗng và đánh số lại liên tục (không để hố 1, 3)', async () => {
    const out = await collect(formatSrt([cue(0, 1, 'a'), cue(1, 2, ' \n '), cue(2, 3, 'c')]));
    expect(
      out
        .split('\n\n')
        .filter(Boolean)
        .map((c) => c.split('\n')[0]),
    ).toEqual(['1', '2']);
  });

  it('text có dòng trống / `-->` không phá cue: parse lại ra đúng số cue và đúng chữ', async () => {
    const out = await collect(
      formatSrt([cue(0, 1_000, 'trước\n\nsau --> nữa'), cue(1_000, 2_000, 'cue hai')]),
    );
    const blocks = out.split('\n\n').filter(Boolean);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe('1\n00:00:00,000 --> 00:00:01,000\ntrước\nsau --> nữa');
  });

  it('nhận cả async iterable (stream từ DB)', async () => {
    async function* source() {
      yield cue(0, 1, 'a');
      yield cue(1, 2, 'b');
    }
    expect((await collect(formatSrt(source()))).match(/-->/g)).toHaveLength(2);
  });

  it('không có cue → rỗng', async () => {
    expect(await collect(formatSrt([]))).toBe('');
  });
});

describe('formatVtt', () => {
  it('có tiêu đề WEBVTT, dấu chấm ở mili giây, không đánh số', async () => {
    const out = await collect(formatVtt([cue(0, 1_500, 'Xin chào'), cue(61_001, 62_000, 'Hai')]));
    expect(out).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nXin chào\n\n00:01:01.001 --> 00:01:02.000\nHai\n\n',
    );
  });

  it('không có cue → vẫn có tiêu đề (file hợp lệ)', async () => {
    expect(await collect(formatVtt([]))).toBe('WEBVTT\n\n');
  });

  it.each([
    ['a & b', 'a &amp; b'],
    ['<b>đậm</b>', '&lt;b&gt;đậm&lt;/b&gt;'],
    ['x --> y', 'x --&gt; y'], // chuỗi bị cấm trong text cue
    ['&lt; đã escape', '&amp;lt; đã escape'], // không escape hai lần nhầm thành "đã escape sẵn"
  ])('escape %j → %j', async (text, escaped) => {
    const out = await collect(formatVtt([cue(0, 1, text)]));
    expect(out).toBe(`WEBVTT\n\n00:00:00.000 --> 00:00:00.001\n${escaped}\n\n`);
    // Mỗi cue đúng MỘT mũi tên (của dòng thời gian).
    expect(out.match(/-->/g)).toHaveLength(1);
  });
});
