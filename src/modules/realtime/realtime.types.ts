import type { Namespace, Socket } from 'socket.io';

/** Danh tính gắn vào socket lúc handshake (như `req.user` của REST). */
export interface SocketUser {
  id: string;
  sessionId: string;
}

/** `socket.data` của namespace `/realtime`. */
export interface RealtimeSocketData {
  user: SocketUser;
}

/** Socket của namespace `/realtime`: không nhận event tự do từ client ngoài các handler đã khai báo. */
export type RealtimeSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  RealtimeSocketData
>;

export type RealtimeNamespace = Namespace<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  RealtimeSocketData
>;

/** Lỗi gửi cho client qua `connect_error` — cùng mã, cùng câu chữ với REST (07 §2). */
export interface RealtimeErrorData {
  code: string;
  statusCode: number;
  message: string;
}
