import type { Namespace, Socket } from 'socket.io';
import type { SessionEndedReason } from '../../infra/realtime/realtime.types.js';

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
}

export type RealtimeSocket = Socket<
  Record<string, never>,
  ServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

export type RealtimeNamespace = Namespace<
  Record<string, never>,
  ServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

/** Lỗi gửi cho client qua `connect_error` — cùng mã, cùng câu chữ với REST (07 §2). */
export interface RealtimeErrorData {
  code: string;
  statusCode: number;
  message: string;
}
