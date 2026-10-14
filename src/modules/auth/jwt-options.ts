import type { JwtModuleOptions } from '@nestjs/jwt';
import { JWT_AUDIENCE, JWT_ISSUER } from './services/token.service.js';

/**
 * Cấu hình JwtModule dùng chung cho AuthModule và test.
 *
 * Ghim `algorithms: ['HS256']` khi verify: chặn tấn công "alg confusion" (token tự khai
 * `alg: none` hoặc đổi thuật toán). Ghim `issuer`/`audience`: token ký cho mục đích khác bằng
 * cùng secret (vd sau này có token mời) không dùng được làm access token.
 */
export function jwtModuleOptions(secret: string): JwtModuleOptions {
  return {
    secret,
    signOptions: { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    verifyOptions: { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  };
}
