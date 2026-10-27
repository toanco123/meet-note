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

  /**
   * Số lần đoạn đã được sửa + 1 (bản máy sinh là 1). Gửi lại qua `If-Match` khi sửa.
   * @example 1
   */
  version: number;

  /** Lần sửa tay gần nhất; `null` nếu còn nguyên bản máy sinh. */
  editedAt: string | null;

  static from(
    row: Pick<TranscriptSegmentRow, 'seq' | 'startMs' | 'endMs' | 'text' | 'version' | 'editedAt'>,
  ): TranscriptSegmentResponseDto {
    return {
      seq: row.seq,
      startMs: row.startMs,
      endMs: row.endMs,
      text: row.text,
      version: row.version,
      editedAt: row.editedAt?.toISOString() ?? null,
    };
  }
}
