import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { jwtModuleOptions } from '../../../../src/modules/auth/jwt-options.js';
import {
  hashRefreshToken,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REFRESH_TOKEN_PATTERN,
  TokenService,
} from '../../../../src/modules/auth/token.service.js';

const SECRET = 'test-secret-'.padEnd(40, 'x');
const CONFIG: Record<string, number> = { JWT_ACCESS_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 30 };

describe('TokenService', () => {
  let tokens: TokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register(jwtModuleOptions(SECRET))],
      providers: [
        TokenService,
        { provide: ConfigService, useValue: { get: (key: string) => CONFIG[key] } },
      ],
    }).compile();
    tokens = moduleRef.get(TokenService);
  });

  /** JwtService độc lập để tự ký những token "xấu" cho test. */
  const rawJwt = (secret = SECRET) => new JwtService({ secret });

  describe('access token', () => {
    it('ký rồi verify lại được sub + sid; expiresAt khớp claim exp', async () => {
      const before = Date.now();
      const issued = await tokens.signAccessToken({ sub: 'user-1', sid: 'session-1' });

      const result = await tokens.verifyAccessToken(issued.token);

      expect(result).toEqual({ ok: true, claims: { sub: 'user-1', sid: 'session-1' } });
      const ttlMs = issued.expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThan(898_000);
      expect(ttlMs).toBeLessThanOrEqual(900_000);
    });

    it('chứa iss/aud cố định', async () => {
      const { token } = await tokens.signAccessToken({ sub: 'u', sid: 's' });
      expect(rawJwt().decode(token)).toMatchObject({
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        sub: 'u',
      });
    });

    it('ký bằng secret khác → invalid', async () => {
      const forged = await rawJwt('another-secret'.padEnd(40, 'y')).signAsync(
        { sid: 's' },
        { subject: 'u', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 60 },
      );
      expect(await tokens.verifyAccessToken(forged)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('hết hạn → expired (phân biệt với invalid)', async () => {
      const expired = await rawJwt().signAsync(
        { sid: 's', exp: Math.floor(Date.now() / 1000) - 10 },
        { subject: 'u', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      );
      expect(await tokens.verifyAccessToken(expired)).toEqual({ ok: false, reason: 'expired' });
    });

    it('đúng secret nhưng sai audience → invalid', async () => {
      const otherAudience = await rawJwt().signAsync(
        { sid: 's' },
        { subject: 'u', issuer: JWT_ISSUER, audience: 'invite-link', expiresIn: 60 },
      );
      expect(await tokens.verifyAccessToken(otherAudience)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('alg "none" (không chữ ký) → invalid', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
        sub: 'u',
        sid: 's',
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 60,
      })}.`;
      expect(await tokens.verifyAccessToken(unsigned)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('thiếu claim sid → invalid', async () => {
      const noSid = await rawJwt().signAsync(
        {},
        { subject: 'u', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 60 },
      );
      expect(await tokens.verifyAccessToken(noSid)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('chuỗi rác → invalid', async () => {
      expect(await tokens.verifyAccessToken('abc.def')).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  describe('refresh token', () => {
    it('43 ký tự base64url, hash SHA-256 32 byte, hạn 30 ngày', () => {
      const now = new Date('2026-10-13T00:00:00Z');
      const issued = tokens.issueRefreshToken(now);

      expect(issued.token).toMatch(REFRESH_TOKEN_PATTERN);
      expect(issued.hash).toHaveLength(32);
      expect(issued.hash.equals(hashRefreshToken(issued.token))).toBe(true);
      expect(issued.expiresAt.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    });

    it('mỗi lần một token khác', () => {
      expect(tokens.issueRefreshToken().token).not.toBe(tokens.issueRefreshToken().token);
    });
  });
});
