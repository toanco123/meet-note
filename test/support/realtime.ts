import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';

/** Cổng thật của app (test gọi `app.listen(0)` trước) — Socket.IO cần kết nối TCP thật. */
export function portOf(app: INestApplication): number {
  return ((app.getHttpServer() as Server).address() as AddressInfo).port;
}

/**
 * Kết nối `/realtime` và đợi KẾT QUẢ handshake: `'OK'` hoặc mã lỗi trong `connect_error`
 * (`err.data.code`). `reconnection: false` — test kiểm từng lần kết nối, không để client tự thử lại.
 * Gọi `socket.disconnect()` khi xong (hoặc `closeAll`).
 */
export async function connectRealtime(
  port: number,
  token: string | undefined,
  /** Header của handshake, vd `{ origin: 'https://…' }` để giả lập trình duyệt. */
  extraHeaders?: Record<string, string>,
): Promise<{ socket: Socket; outcome: string }> {
  const socket = io(`http://127.0.0.1:${port}/realtime`, {
    auth: token === undefined ? {} : { token },
    ...(extraHeaders && { extraHeaders }),
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const outcome = await new Promise<string>((resolve) => {
    socket.once('connect', () => resolve('OK'));
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) =>
      resolve(error.data?.code ?? `lỗi không mã: ${error.message}`),
    );
  });
  return { socket, outcome };
}

/** Promise resolve khi socket nhận `event` lần tới (kèm payload), hoặc reject sau `timeoutMs`. */
export function nextEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Không nhận được "${event}" sau ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
