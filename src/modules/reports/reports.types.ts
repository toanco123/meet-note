import type { MeetingSummaryContent } from '../../infra/llm/llm.types.js';

/** Meeting đủ điều kiện vào báo cáo tuần của một kênh (M9 Q2), kèm tóm tắt — đầu vào của `ReportWriter`. */
export interface ReportMeeting {
  id: string;
  title: string;
  recordedAt: Date;
  summary: MeetingSummaryContent;
}
