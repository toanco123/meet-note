import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  OPAQUE_TOKEN_PATTERN,
} from '../../common/crypto/opaque-token.js';
import type { EnvironmentVariables } from '../../config/env.validation.js';

export const JWT_ISSUER = 'meetnote-api';
export const JWT_AUDIENCE = 'meetnote';

/** 32 byte ngẫu nhiên → 43 ký tự base64url. DTO dùng regex này để từ chối rác trước khi tra DB. */
export const REFRESH_TOKEN_PATTERN = OPAQUE_TOKEN_PATTERN;

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

/** SHA-256 đủ cho refresh token (entropy 256 bit) — không cần hash chậm như mật khẩu. */
export const hashRefreshToken = hashOpaqueToken;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<IssuedToken> {
    const token = await this.jwt.signAsync(
      { sid: claims.sid },
      {
        subject: claims.sub,
        expiresIn: this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }),
      },
    );
    // Lấy `exp` từ chính token thay vì tự cộng giờ → không lệch giây với giá trị đã ký.
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Không ném lỗi: trả lý do để guard chọn mã lỗi (`AUTH_TOKEN_EXPIRED` vs `AUTH_TOKEN_INVALID`). */
  async verifyAccessToken(token: string): Promise<AccessTokenVerification> {
    try {
      // algorithms/issuer/audience đã ghim trong verifyOptions của JwtModule (auth.module.ts).
      const payload = await this.jwt.verifyAsync<{ sub?: unknown; sid?: unknown }>(token);
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, claims: { sub: payload.sub, sid: payload.sid } };
    } catch (error) {
      // jsonwebtoken kiểm tra chữ ký TRƯỚC hạn dùng: token giả mạo đã hết hạn vẫn là 'invalid'.
      return { ok: false, reason: error instanceof TokenExpiredError ? 'expired' : 'invalid' };
    }
  }

  issueRefreshToken(now = new Date()): IssuedToken & { hash: Buffer } {
    const { token, hash } = generateOpaqueToken();
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
    return {
      token,
      hash,
      expiresAt: new Date(now.getTime() + ttlDays * 24 * 3600 * 1000),
    };
  }
}
