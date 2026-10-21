import type { Namespace, RemoteSocket, Socket } from 'socket.io';
import type { AccessScope, SessionEndedReason } from '../../infra/realtime/realtime.types.js';

/** Danh tính gắn vào socket lúc handshake (như `req.user` của REST). */
export interface SocketUser {
  id: string;
  sessionId: string;
  /** `exp` của access token dùng để kết nối — server tự ngắt lúc này (M7 Q1). */
  tokenExpiresAt: Date;
}

/** `socket.data` của namespace `/realtime`. */
export interface RealtimeSocketData {
  user: SocketUser;
}

/** Event server → client của `/realtime` (05 Realtime). Phát sai tên / sai payload = lỗi compile. */
export interface ServerToClientEvents {
  'session.ended': (payload: { reason: SessionEndedReason }) => void;
  'meeting.status': (payload: MeetingStatusEvent) => void;
  /** Đã bị cho rời room `meeting:{id}` vì mất quyền xem (M7 Q2). */
  'meeting.access_revoked': (payload: { meetingId: string }) => void;
}

/** Event giữa các api instance (qua Redis adapter / emitter), không tới client. */
export interface ServerSideEvents {
  'realtime.revalidate': (scope: AccessScope) => void;
}

/** Payload nhỏ — chỉ là GỢI Ý; client cần chi tiết thì gọi REST (02 §2). */
export interface MeetingStatusEvent {
  meetingId: string;
  status: string;
  failureCode?: string | null;
}

/** Ack của `subscribe` / `unsubscribe`: cùng vỏ với REST — có `data` là thành công, có `error` là lỗi. */
export type RealtimeAck<T> = { data: T } | { error: RealtimeErrorData };

export type RealtimeSocket = Socket<
  Record<string, never>,
  ServerToClientEvents,
  ServerSideEvents,
  RealtimeSocketData
>;

export type RealtimeNamespace = Namespace<
  Record<string, never>,
  ServerToClientEvents,
  ServerSideEvents,
  RealtimeSocketData
>;

/** Lỗi gửi cho client qua `connect_error` — cùng mã, cùng câu chữ với REST (07 §2). */
export interface RealtimeErrorData {
  code: string;
  statusCode: number;
  message: string;
}

/** Socket trả về từ `fetchSockets()` (có thể ở instance khác; `.local` thì chắc chắn ở đây). */
export type RemoteRealtimeSocket = RemoteSocket<ServerToClientEvents, RealtimeSocketData>;
