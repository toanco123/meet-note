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
