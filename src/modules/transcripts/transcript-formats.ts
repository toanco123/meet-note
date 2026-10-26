import type { SubtitleCue } from './transcripts.types.js';

export const SUBTITLE_FORMATS = ['srt', 'vtt'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/**
 * `HH:MM:SS<sep>mmm`. Giờ không bị cắt ở 2 chữ số (bản ghi tối đa 4 giờ, nhưng dữ liệu sửa tay hay
 * import có thể dài hơn — "100:00:00,000" vẫn đọc được, còn tràn thì sai im lặng).
 * SRT dùng dấu phẩy, VTT dùng dấu chấm.
 */
export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.trunc(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(total % 1_000, 3)}`;
}

/**
 * Chuẩn hoá nội dung một cue. MỘT DÒNG TRỐNG kết thúc cue ở cả SRT lẫn VTT — text có hai xuống dòng
 * liên tiếp sẽ cắt cue làm đôi, phần sau thành rác. Nên: thống nhất xuống dòng, bỏ ký tự điều khiển,
 * bỏ dòng trống, cắt khoảng trắng đầu/cuối từng dòng. Rỗng → `undefined` (bỏ cue).
 */
export function normalizeCueText(text: string): string | undefined {
  const lines = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * VTT: `&`, `<`, `>` có nghĩa trong text (thẻ, thực thể) → escape. Escape `>` cũng loại luôn `-->`
 * (VTT cấm chuỗi này trong text cue). SRT không có đặc tả chặt: player hiểu `<b>`, `<i>`, `<font>` —
 * để nguyên (transcript là chữ, không phải mã), chỉ cần cue không bị cắt.
 */
export function escapeVttText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** SRT: `1\n00:00:01,000 --> 00:00:02,500\ntext\n\n`, đánh số từ 1 theo cue được ghi. */
export async function* formatSrt(
  cues: AsyncIterable<SubtitleCue> | Iterable<SubtitleCue>,
): AsyncGenerator<string> {
  let n = 0;
  for await (const cue of cues) {
    const text = normalizeCueText(cue.text);
    if (text === undefined) continue;
    n += 1;
    yield `${n}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${text}\n\n`;
  }
}

/** VTT: tiêu đề `WEBVTT`, mỗi cue `start --> end\ntext\n\n`. */
export async function* formatVtt(
  cues: AsyncIterable<SubtitleCue> | Iterable<SubtitleCue>,
): AsyncGenerator<string> {
  yield 'WEBVTT\n\n';
  for await (const cue of cues) {
    const text = normalizeCueText(cue.text);
    if (text === undefined) continue;
    yield `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${escapeVttText(text)}\n\n`;
  }
}

export function formatSubtitles(
  format: SubtitleFormat,
  cues: AsyncIterable<SubtitleCue> | Iterable<SubtitleCue>,
): AsyncGenerator<string> {
  return format === 'srt' ? formatSrt(cues) : formatVtt(cues);
}
