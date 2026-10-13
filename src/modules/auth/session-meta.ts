import type { Request } from 'express';
import type { SessionMeta } from './sessions.repository.js';

const MAX_USER_AGENT_LENGTH = 512;

/**
 * Thông tin thiết bị hiển thị trong `/me/sessions`.
 *
 * BẪY: `req.ip` là IP của kết nối TCP. Chạy sau reverse proxy / load balancer thì đây là IP của
 * proxy — phải bật `app.set('trust proxy', …)` đúng số tầng proxy, KHÔNG tin `X-Forwarded-For`
 * một cách mù quáng (client tự gửi header này được).
 */
export function sessionMetaOf(req: Request): SessionMeta {
  return {
    userAgent: req.get('user-agent')?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    ip: req.ip ?? null,
  };
}
