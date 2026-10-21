/**
 * Phạm vi một thay đổi có thể làm MẤT quyền xem meeting (M7 Q2) — gateway chỉ kiểm lại đúng nhóm
 * socket bị ảnh hưởng thay vì mọi subscription:
 * - `meeting`: gỡ share, xoá meeting → socket trong room của meeting đó;
 * - `user`: bị gỡ khỏi kênh / org, rời kênh / org, mất vai trò Admin org → các room meeting của
 *   socket người đó;
 * - `channel`: kênh đổi sang riêng tư / bị xoá → room của các meeting share vào kênh;
 * - `org`: tổ chức bị xoá → room của các meeting thuộc tổ chức.
 */
export type AccessScope =
  | { kind: 'meeting'; meetingId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'org'; orgId: string };

/** Vì sao server chủ động kết thúc kết nối — gửi kèm event `session.ended` ngay trước khi ngắt. */
export type SessionEndedReason = 'token_expired' | 'session_revoked';

/**
 * Phát event / ngắt socket tới các ROOM của namespace `/realtime`, từ BẤT KỲ tiến trình nào (api,
 * worker) và tới socket ở BẤT KỲ api instance nào — đi qua Redis. Module domain chỉ biết interface
 * này, không biết Socket.IO.
 *
 * Fire-and-forget: Redis pub/sub không xác nhận người nhận; event realtime chỉ là GỢI Ý, DB mới là
 * nguồn sự thật (02 §2). Gọi SAU KHI transaction commit.
 */
export interface RealtimePublisher {
  emit(rooms: string[], event: string, payload: unknown): void;
  /** Gửi `session.ended { reason }` rồi ngắt mọi socket trong các room đó. */
  endSessions(rooms: string[], reason: SessionEndedReason): void;
  /** Yêu cầu MỌI api instance kiểm lại quyền của các subscription trong phạm vi này (sau commit). */
  revalidateAccess(scope: AccessScope): void;
}
