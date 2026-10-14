import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/auth/public.decorator.js';
import { SessionsService } from '../services/sessions.service.js';
import { TokenService } from '../services/token.service.js';
import { Errors } from '../../../common/errors/errors.js';

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
      throw Errors.auth.tokenMissing();
    }

    const verified = await this.tokens.verifyAccessToken(token);
    if (!verified.ok) {
      throw verified.reason === 'expired' ? Errors.auth.tokenExpired() : Errors.auth.tokenInvalid();
    }

    const { sub, sid } = verified.claims;
    if (!(await this.sessions.isActive(sid, sub))) {
      throw Errors.auth.sessionRevoked();
    }

    request.user = { id: sub, sessionId: sid };
    return true;
  }
}
