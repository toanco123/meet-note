import type { Readable } from 'node:stream';
import type { MeetingViewer } from '../meetings/meetings.types.js';

export interface SearchMeetingsParams {
  orgId: string;
  viewer: MeetingViewer;
  /** Chuỗi người dùng gõ — `websearch_to_tsquery` tự xử lý ký tự đặc biệt (không ném lỗi cú pháp). */
  query: string;
  /** Chỉ meeting share vào kênh này — service đã kiểm người xem đọc được nội dung kênh. */
  channelId?: string;
  /** Khoá cursor của dòng cuối trang trước: `(recorded_at, id)`, thời gian dạng text đủ micro giây. */
  after?: { recordedAt: string; id: string };
  limit: number;
}

/** Một meeting có đoạn khớp: kèm số đoạn khớp và khoá cursor do Postgres in. */
export interface SearchMeetingRow {
  id: string;
  title: string;
  recordedAt: Date;
  recordedAtKey: string;
  hitCount: number;
}

/** Đoạn khớp của một meeting kèm đoạn trích đã đánh dấu từ khoá. */
export interface SearchHitRow {
  meetingId: string;
  seq: number;
  startMs: number;
  endMs: number;
  snippet: string;
}

/** Một cue phụ đề (SRT / VTT) — chỉ cần thời gian và chữ của đoạn transcript. */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleDownload {
  contentType: string;
  contentDisposition: string;
  stream: Readable;
}
