import type { ReportInput } from '../../infra/llm/llm.types.js';
import { addDays } from './report-week.js';
import type { ReportMeeting, SelectedMeetings } from './reports.types.js';

/**
 * Trần số meeting đưa vào MỘT prompt báo cáo. Đầu vào là tóm tắt (vài trăm token mỗi meeting) nên
 * 100 meeting ≈ vài chục nghìn token — vẫn nhỏ so với context, nhưng một kênh bất thường (import
 * hàng loạt) không được làm prompt phình vô hạn.
 */
export const MAX_REPORT_MEETINGS = 100;

/**
 * Giữ tối đa `max` meeting MỚI NHẤT (đầu vào cũ nhất trước): cuối tuần là trạng thái mới nhất, quyết
 * định sau thường thay thế quyết định trước. Kết quả vẫn cũ nhất trước.
 */
export function selectMeetings(
  meetings: ReportMeeting[],
  max: number = MAX_REPORT_MEETINGS,
): SelectedMeetings {
  if (meetings.length <= max) return { included: meetings, truncated: false };
  return { included: meetings.slice(meetings.length - max), truncated: true };
}

export function buildReportInput(
  channelName: string,
  weekStart: string,
  meetings: ReportMeeting[],
): ReportInput {
  return {
    channelName,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    meetings: meetings.map((m) => ({
      id: m.id,
      title: m.title,
      recordedAt: m.recordedAt.toISOString(),
      summary: m.summary,
    })),
  };
}
