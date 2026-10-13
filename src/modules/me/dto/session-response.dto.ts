import type { SessionRow } from '../../../infra/database/schema/index.js';

export class SessionResponseDto {
  id: string;

  /** @example "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) …" */
  userAgent: string | null;

  /** @example "203.0.113.7" */
  ip: string | null;

  /** Thời điểm đăng nhập. */
  createdAt: string;

  /** Lần refresh gần nhất. */
  lastUsedAt: string;

  /** `true` nếu đây là phiên đang gửi request này. */
  current: boolean;

  static from(row: SessionRow, currentSessionId: string): SessionResponseDto {
    return {
      id: row.id,
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      current: row.id === currentSessionId,
    };
  }
}
