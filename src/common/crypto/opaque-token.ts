import { createHash, randomBytes } from 'node:crypto';

/** 32 byte ngẫu nhiên → 43 ký tự base64url. Dùng cho refresh token, link mời… */
export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256 đủ cho token entropy cao (256 bit): không thể dò ngược, tra cứu nhanh bằng unique index.
 * KHÔNG dùng cho mật khẩu (entropy thấp → cần hash chậm như argon2).
 */
export function hashOpaqueToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function generateOpaqueToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}
