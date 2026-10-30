/** Payload job dùng chung cho producer (api) và consumer (worker). CHỈ chứa ID — worker tự đọc DB. */

/** `meeting.preprocess` / `meeting.transcribe` / `meeting.summarize` (M6). */
export interface MeetingJobData {
  meetingId: string;
  /**
   * Lần chạy pipeline — fencing token (M6 Q6): job của lần chạy cũ bị loại. Job M5 enqueue trước M6
   * không có trường này → coi là 1 (đúng với jobId `…a1` của chúng).
   */
  attempt?: number;
  /** Nối log của request đã tạo job với log của worker. */
  requestId: string | null;
}

/**
 * `notification.fanout` (M10 B5): thông báo NHIỀU người nhận. Không mang danh sách người nhận /
 * tên — worker đọc lại lúc chạy (người vừa rời kênh không nhận; đã gỡ share → không ai nhận).
 */
export type NotificationFanoutJobData = MeetingSharedFanoutJobData | ReportReadyFanoutJobData;

export interface MeetingSharedFanoutJobData {
  type: 'meeting.shared';
  meetingId: string;
  channelId: string;
  requestId: string | null;
}

/** Báo cáo tuần theo lịch xong (M9 Q7): thành viên kênh trừ Khách. Đọc lại báo cáo lúc chạy. */
export interface ReportReadyFanoutJobData {
  type: 'report.ready';
  reportId: string;
  version: number;
  requestId: string | null;
}

/** `weekly-report.generate` (M9): MỘT báo cáo. `generation` = `regenerate_count` lúc enqueue (fencing). */
export interface WeeklyReportGenerateJobData {
  reportId: string;
  generation: number;
  requestId: string | null;
}

/**
 * `weekly-report.tick` (M9). Lịch (Job Scheduler) tạo job với `{}` — tuần suy từ thời điểm lịch bắn.
 * Backfill chỉ định `weekStart` (Thứ Hai, 'YYYY-MM-DD') để chạy bù một tuần bất kỳ.
 */
export interface WeeklyReportTickJobData {
  weekStart?: string;
  requestId?: string | null;
}

/**
 * `stats.rollup` (M17): tính lại rollup của MỘT tổ chức. `day` = ngày lịch giờ VN ('YYYY-MM-DD');
 * `span` > 1 tính lại `span` ngày kết thúc ở `day` (job đêm làm lưới an toàn: mặc định 1).
 */
export interface StatsRollupJobData {
  orgId: string;
  day: string;
  span?: number;
  requestId?: string | null;
}
