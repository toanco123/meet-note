import type { TranscriptSegmentRow } from '../../../infra/database/schema/index.js';

/** Một đoạn transcript (M6). Danh sách theo `seq` tăng dần, cursor `meta.nextCursor`. */
export class TranscriptSegmentResponseDto {
  /** Thứ tự trong cuộc họp, bắt đầu từ 0. @example 0 */
  seq: number;

  /** Mốc bắt đầu tính từ đầu bản ghi (ms). @example 0 */
  startMs: number;

  /** @example 4200 */
  endMs: number;

  /** @example "Chào mọi người, hôm nay họp về kế hoạch quý ba." */
  text: string;

  static from(
    row: Pick<TranscriptSegmentRow, 'seq' | 'startMs' | 'endMs' | 'text'>,
  ): TranscriptSegmentResponseDto {
    return { seq: row.seq, startMs: row.startMs, endMs: row.endMs, text: row.text };
  }
}
