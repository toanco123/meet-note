import type {
  MeetingFailureCode,
  NotificationType,
  OrgRoleValue,
} from '../../infra/database/schema/index.js';

/**
 * Payload theo TỪNG loại (M10 Q4: id + tên lúc tạo). Tạo thông báo thiếu trường / sai loại = lỗi compile.
 * Client hiển thị câu chữ từ đây; cần chi tiết mới nhất thì gọi REST (có kiểm quyền).
 */
export interface NotificationPayloads {
  'channel.member_added': {
    channelId: string;
    channelName: string;
    role: string;
    actorId: string;
    actorName: string;
  };
  'channel.ownership_transferred': {
    channelId: string;
    channelName: string;
    newOwnerId: string;
    newOwnerName: string;
    previousOwnerId: string | null;
    previousOwnerName: string | null;
    actorId: string;
    actorName: string;
  };
  'org.join_request_approved': {
    orgName: string;
    role: OrgRoleValue;
  };
  'meeting.shared': {
    meetingId: string;
    meetingTitle: string;
    channelId: string;
    channelName: string;
    /** NULL khi tài khoản người share đã bị xoá (`meeting_shares.shared_by` SET NULL). */
    actorId: string | null;
    actorName: string | null;
  };
  /** Chủ meeting (M6 Q7): pipeline xử lý xong. */
  'meeting.completed': {
    meetingId: string;
    meetingTitle: string;
  };
  /** Chủ meeting (M6 Q7): pipeline dừng ở `failed` — chạy lại được. */
  'meeting.failed': {
    meetingId: string;
    meetingTitle: string;
    failureCode: MeetingFailureCode;
  };
  /** Báo cáo tuần xong (M9 Q7): theo lịch → thành viên kênh trừ Khách; tạo lại thủ công → người bấm. */
  'report.ready': {
    reportId: string;
    channelId: string;
    channelName: string;
    /** Thứ Hai của tuần, 'YYYY-MM-DD'. */
    weekStart: string;
    version: number;
  };
}

/** Một thông báo chuẩn bị ghi — kiểu `payload` đi theo `type`. */
export type NotificationDraft = {
  [K in NotificationType]: {
    userId: string;
    orgId: string | null;
    type: K;
    payload: NotificationPayloads[K];
    /** Chống trùng khi chạy lại (job); thao tác trong transaction thường không cần. */
    dedupeKey?: string;
  };
}[NotificationType];

/**
 * `notification.read` tới `user:{id}` (M10 B4) — các phiên KHÁC của cùng người cập nhật số chưa đọc.
 * Đọc hết gửi `{ all }` thay vì danh sách id (có thể rất dài); client coi là gợi ý và lấy lại
 * `unread-count` qua REST.
 */
export type NotificationReadEvent = { ids: string[] } | { all: true; orgId: string | null };

export interface ListNotificationsParams {
  userId: string;
  orgId?: string;
  unreadOnly: boolean;
  /** Khoá cursor dòng cuối trang trước: `(created_at, id)`, thời gian dạng text đủ micro giây. */
  after?: { createdAt: string; id: string };
  limit: number;
}

export interface FanoutRecipientsParams {
  meetingId: string;
  channelId: string;
  /** Người share — không tự báo cho mình. */
  excludeUserId: string | null;
  /** Keyset: `user_id` cuối của lô trước. */
  afterUserId: string | null;
  limit: number;
}
