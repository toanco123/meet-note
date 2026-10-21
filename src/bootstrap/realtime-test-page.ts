import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';

export const REALTIME_TEST_PAGE_PATH = '/realtime-test.html';

/**
 * Trang thử Socket.IO (M7) — CHỈ bật ở `NODE_ENV=development` (main.ts), như công cụ dev. Không chứa
 * dữ liệu: dán access token (lấy từ Swagger `/docs`), kết nối `/realtime`, subscribe meeting, xem
 * event. Client Socket.IO lấy từ chính server (`/socket.io/socket.io.js`, `serveClient` mặc định),
 * không cần CDN hay build front-end. Route gắn thẳng vào Express → không qua versioning / guard.
 */
export function setupRealtimeTestPage(app: INestApplication): void {
  app
    .getHttpAdapter()
    .get(REALTIME_TEST_PAGE_PATH, (_req: Request, res: Response) => res.type('html').send(PAGE));
}

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeetNote realtime</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 760px; margin: 24px auto; padding: 0 16px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 6px; font-family: ui-monospace, monospace; }
  button { margin: 8px 8px 0 0; padding: 6px 12px; }
  #log { margin-top: 16px; padding: 8px; min-height: 240px; border: 1px solid #8884;
         font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>MeetNote realtime</h1>
<p>Dán access token (đăng nhập ở <a href="/docs">/docs</a>), kết nối, rồi subscribe một meeting.</p>
<label for="token">Access token</label>
<input id="token" autocomplete="off">
<button id="connect">Kết nối</button><button id="disconnect">Ngắt</button>
<label for="meeting">Meeting id</label>
<input id="meeting" autocomplete="off">
<button id="subscribe">Subscribe</button><button id="unsubscribe">Unsubscribe</button>
<div id="log" role="log" aria-live="polite"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const $ = (id) => document.getElementById(id);
  const log = (...parts) => {
    const line = new Date().toLocaleTimeString() + '  ' + parts.map((p) =>
      typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    $('log').textContent = line + '\\n' + $('log').textContent;
  };
  let socket;
  $('connect').onclick = () => {
    socket?.disconnect();
    socket = io('/realtime', { auth: { token: $('token').value.trim() }, transports: ['websocket'] });
    socket.on('connect', () => log('đã kết nối', socket.id));
    socket.on('connect_error', (e) => log('từ chối:', e.data ?? e.message));
    socket.on('disconnect', (reason) => log('ngắt:', reason));
    socket.onAny((event, payload) => log('event', event, payload));
  };
  $('disconnect').onclick = () => socket?.disconnect();
  const ack = (event) => async () => {
    if (!socket) return log('chưa kết nối');
    log(event, await socket.timeout(5000).emitWithAck(event, { meetingId: $('meeting').value.trim() }));
  };
  $('subscribe').onclick = ack('subscribe');
  $('unsubscribe').onclick = ack('unsubscribe');
</script>
</body>
</html>
`;
