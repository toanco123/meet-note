import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/auth/public.decorator.js';
import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-code.js';
import { SessionsService } from '../sessions.service.js';
import { TokenService } from '../token.service.js';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

/**
 * Guard TOÀN CỤC (đăng ký bằng APP_GUARD trong AuthModule): mọi route mặc định yêu cầu đăng nhập,
 * trừ route/controller có `@Public()`. Mặc định đóng → quên đánh dấu thì lỗi theo hướng an toàn.
 *
 * Hai lớp kiểm tra:
 * 1. Chữ ký + hạn của JWT (không chạm DB).
 * 2. Phiên còn sống (1 query theo khoá chính) → logout/thu hồi có hiệu lực NGAY (quyết định Q1 của M1).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket (M7) xác thực ở handshake, không qua guard này. Chặn mặc định cho an toàn.
    if (context.getType() !== 'http') return false;

    // getAllAndOverride: metadata ở method thắng metadata ở class.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw unauthorized(
        ErrorCode.AuthTokenMissing,
        'Thiếu access token (Authorization: Bearer …).',
      );
    }

    const verified = await this.tokens.verifyAccessToken(token);
    if (!verified.ok) {
      throw verified.reason === 'expired'
        ? unauthorized(ErrorCode.AuthTokenExpired, 'Access token đã hết hạn. Hãy refresh.')
        : unauthorized(ErrorCode.AuthTokenInvalid, 'Access token không hợp lệ.');
    }

    const { sub, sid } = verified.claims;
    if (!(await this.sessions.isActive(sid, sub))) {
      throw unauthorized(ErrorCode.AuthSessionRevoked, 'Phiên đăng nhập đã bị thu hồi.');
    }

    request.user = { id: sub, sessionId: sid };
    return true;
  }
}

function unauthorized(code: ErrorCode, message: string): AppException {
  return new AppException(code, HttpStatus.UNAUTHORIZED, message);
}
