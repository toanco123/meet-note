import type { AuthTokens } from '../sessions.service.js';

export class AuthTokensResponseDto {
  /** Luôn là `Bearer`: gửi `Authorization: Bearer <accessToken>`. */
  tokenType: 'Bearer';

  /** JWT sống ngắn (mặc định 15 phút). */
  accessToken: string;

  /**
   * Thời điểm access token hết hạn (ISO 8601, UTC).
   * @example "2026-10-13T08:15:00.000Z"
   */
  accessTokenExpiresAt: string;

  /**
   * Dùng một lần cho `POST /v1/auth/refresh`; mỗi lần refresh nhận token mới.
   * @example "q3Jt0b6Q2l3Zc0p9QpXb5m1q8D0yJ4dA7m2N5r1sT6w"
   */
  refreshToken: string;

  /**
   * Thời điểm refresh token hết hạn (ISO 8601, UTC).
   * @example "2026-11-12T08:00:00.000Z"
   */
  refreshTokenExpiresAt: string;

  static from(tokens: AuthTokens): AuthTokensResponseDto {
    return {
      tokenType: 'Bearer',
      accessToken: tokens.accessToken.token,
      accessTokenExpiresAt: tokens.accessToken.expiresAt.toISOString(),
      refreshToken: tokens.refreshToken.token,
      refreshTokenExpiresAt: tokens.refreshToken.expiresAt.toISOString(),
    };
  }
}
