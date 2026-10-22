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
export interface NotificationFanoutJobData {
  type: 'meeting.shared';
  meetingId: string;
  channelId: string;
  requestId: string | null;
}
