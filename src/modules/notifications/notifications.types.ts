import type { NotificationType, OrgRoleValue } from '../../infra/database/schema/index.js';

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
    actorId: string;
    actorName: string;
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
