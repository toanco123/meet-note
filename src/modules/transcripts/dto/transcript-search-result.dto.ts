import type { SearchHitRow, SearchMeetingRow } from '../transcripts.types.js';

export class TranscriptSearchHitResponseDto {
  /** Thứ tự đoạn trong transcript (cursor của `GET …/transcript`). */
  seq: number;

  /** Mốc bắt đầu, mili giây từ đầu bản ghi. */
  startMs: number;

  endMs: number;

  /**
   * Đoạn trích; từ khoá nằm giữa ký tự điều khiển U+0001 (mở) và U+0002 (đóng). Không phải HTML —
   * client tự đổi thành thẻ đánh dấu, và PHẢI escape phần còn lại của chuỗi.
   * @example "Chốt \u0001kế hoạch\u0002 quý ba"
   */
  snippet: string;
}

export class TranscriptSearchResultResponseDto {
  meetingId: string;

  title: string;

  /** @example "2026-10-21T02:00:00.000Z" */
  recordedAt: string;

  /** Tổng số đoạn khớp trong meeting (có thể nhiều hơn `hits`). */
  hitCount: number;

  /** Tối đa 3 đoạn khớp đầu tiên theo thời gian. */
  hits: TranscriptSearchHitResponseDto[];

  static from(row: SearchMeetingRow, hits: SearchHitRow[]): TranscriptSearchResultResponseDto {
    return {
      meetingId: row.id,
      title: row.title,
      recordedAt: row.recordedAt.toISOString(),
      hitCount: row.hitCount,
      hits: hits.map((h) => ({
        seq: h.seq,
        startMs: h.startMs,
        endMs: h.endMs,
        snippet: h.snippet,
      })),
    };
  }
}
