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
}
