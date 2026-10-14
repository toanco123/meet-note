/** Kiểu viết tay của module auth: token, phiên đăng nhập. */

// ── Token ─────────────────────────────────────────────────────────────────────

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** session id — không đổi suốt phiên, guard dùng để kiểm tra phiên còn sống. */
  sid: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export type AccessTokenVerification =
  { ok: true; claims: AccessTokenClaims } | { ok: false; reason: 'expired' | 'invalid' };

// ── Phiên đăng nhập ───────────────────────────────────────────────────────────

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface AuthTokens {
  userId: string;
  sessionId: string;
  accessToken: IssuedToken;
  refreshToken: IssuedToken;
}
