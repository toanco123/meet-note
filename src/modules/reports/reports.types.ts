import type { ReportStatus } from '../../infra/database/schema/index.js';
import type { MeetingSummaryContent } from '../../infra/llm/llm.types.js';

/** Meeting đủ điều kiện vào báo cáo tuần của một kênh (M9 Q2), kèm tóm tắt — đầu vào của `ReportWriter`. */
export interface ReportMeeting {
  id: string;
  title: string;
  recordedAt: Date;
  summary: MeetingSummaryContent;
}

/** Kết quả chọn meeting cho một prompt báo cáo (xem `selectMeetings`). */
export interface SelectedMeetings {
  included: ReportMeeting[];
  /** Có meeting bị bỏ vì vượt trần (ghi vào `weekly_report_versions.truncated`). */
  truncated: boolean;
}

/**
 * Payload job `weekly-report.generate` (CHỈ id + số nguyên). `generation` = `regenerate_count` lúc
 * enqueue — fencing như `attempt` của meeting: job / sự kiện `failed` của lần tạo CŨ không đè lên lần
 * tạo lại. Tick tạo dòng với 0; mỗi lần tạo lại tăng 1.
 */
export interface ReportJob {
  reportId: string;
  generation: number;
  requestId: string | null;
}

/** Báo cáo vừa được nhận việc (lease) — đủ để chạy mà không đọc lại. */
export interface ClaimedReport {
  id: string;
  orgId: string;
  channelId: string;
  channelName: string;
  /** Thứ Hai của tuần, 'YYYY-MM-DD'. */
  weekStart: string;
  generation: number;
  requestedTrigger: 'scheduled' | 'manual';
  requestedBy: string | null;
  generationToken: string;
}

/**
 * - `completed`: đã ghi phiên bản mới.
 * - `skipped`: dưới 2 meeting → `skipped` (không gọi LLM).
 * - `ignored`: job cũ / trùng / báo cáo đã xong hay đã xoá / đang có người giữ / mất lease giữa chừng.
 */
export type ReportOutcome = 'completed' | 'skipped' | 'ignored';

export interface ReportGenerationOptions {
  /** Lease cho một lần tạo: ≥ thời gian tối đa của LLM (timeout × (retry + 1)) + biên. */
  leaseMs: number;
  /** Trần số meeting đưa vào prompt (xem `selectMeetings`). */
  maxMeetings: number;
}

/** Phiên bản vừa sinh, chuẩn bị ghi. */
export interface NewReportVersion {
  trigger: 'scheduled' | 'manual';
  triggeredBy: string | null;
  content: Record<string, unknown>;
  meetingIds: string[];
  truncated: boolean;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TickResult {
  /** Số kênh đã duyệt (bật báo cáo, chưa xoá, chưa lưu trữ). */
  channels: number;
  /** Số dòng báo cáo MỚI tạo (lần chạy lại: 0). */
  created: number;
  /** Số job đã xếp (mọi dòng `pending` của tuần, kể cả của tick trước). */
  enqueued: number;
}

/** Báo cáo chưa xong, lâu không đổi và không ai giữ lease — ứng viên của quét kẹt (B7). */
export interface StuckReport {
  id: string;
  generation: number;
  status: ReportStatus;
  /** `updated_at` dạng text (đủ micro giây) — keyset giữa các lô. */
  updatedAt: string;
  /** `updated_at` tính bằng micro giây epoch — hậu tố jobId. */
  version: string;
}

export interface ReportSweepResult {
  requeued: string[];
  /** Job thường còn sống (chờ / chờ retry / đang chạy) → để yên. */
  skipped: string[];
}
