import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import type { SessionRevokedReason, SessionRow } from '../../infra/database/schema/index.js';
import { SessionsRepository } from './sessions.repository.js';
import { hashRefreshToken, TokenService } from './token.service.js';
import { Errors } from '../../common/errors/errors.js';
import type { AuthTokens, IssuedToken, SessionMeta } from './auth.types.js';

/** Kết quả bên trong transaction. Lỗi được ném SAU khi commit — xem `rotate()`. */
type RotateOutcome =
  | { kind: 'ok'; userId: string; sessionId: string; refreshToken: IssuedToken }
  | { kind: 'invalid' }
  | { kind: 'rotated' }
  | { kind: 'reused'; sessionId: string };

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: SessionsRepository,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Đăng nhập / đăng ký thành công → mở phiên mới + cấp cặp token. */
  async create(userId: string, meta: SessionMeta): Promise<AuthTokens> {
    const refresh = this.tokens.issueRefreshToken();

    // Session và refresh token đầu tiên phải cùng tồn tại hoặc cùng không.
    const session = await this.db.transaction(async (tx) => {
      const created = await this.repo.insertSession(userId, meta, tx);
      await this.repo.insertRefreshToken(
        { sessionId: created.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt },
        tx,
      );
      return created;
    });

    // Ký JWT không cần DB → để ngoài transaction cho transaction ngắn nhất có thể.
    const accessToken = await this.tokens.signAccessToken({ sub: userId, sid: session.id });
    return {
      userId,
      sessionId: session.id,
      accessToken,
      refreshToken: { token: refresh.token, expiresAt: refresh.expiresAt },
    };
  }

  /**
   * Xoay vòng refresh token. Xem docs/design/03-database.md §1.
   *
   * BẪY: nếu ném AppException ngay trong callback của `db.transaction`, transaction ROLLBACK —
   * kéo theo lệnh thu hồi phiên khi phát hiện reuse cũng bị huỷ, kẻ trộm token vẫn dùng tiếp
   * được. Vì vậy callback chỉ TRẢ VỀ kết quả; quyết định ném lỗi nằm sau khi commit.
   */
  async rotate(refreshToken: string): Promise<AuthTokens> {
    const now = new Date();
    const graceMs = this.config.get('REFRESH_REUSE_GRACE_SECONDS', { infer: true }) * 1000;
    const hash = hashRefreshToken(refreshToken);

    const outcome = await this.db.transaction(async (tx): Promise<RotateOutcome> => {
      // Thứ tự khoá cố định: refresh_token → session (không đường nào khoá ngược lại → không deadlock).
      const current = await this.repo.findRefreshTokenForUpdate(hash, tx);
      if (!current) return { kind: 'invalid' };

      const session = await this.repo.findSessionForUpdate(current.sessionId, tx);
      if (!session || session.revokedAt) return { kind: 'invalid' };

      if (current.rotatedAt) {
        if (now.getTime() - current.rotatedAt.getTime() <= graceMs) {
          return { kind: 'rotated' };
        }
        await this.repo.revokeSession(
          { sessionId: session.id, reason: 'reuse_detected', at: now },
          tx,
        );
        return { kind: 'reused', sessionId: session.id };
      }

      if (current.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' };

      const next = this.tokens.issueRefreshToken(now);
      const inserted = await this.repo.insertRefreshToken(
        { sessionId: session.id, tokenHash: next.hash, expiresAt: next.expiresAt },
        tx,
      );
      await this.repo.markRotated(current.id, inserted.id, now, tx);
      await this.repo.touchSession(session.id, now, tx);

      return {
        kind: 'ok',
        userId: session.userId,
        sessionId: session.id,
        refreshToken: { token: next.token, expiresAt: next.expiresAt },
      };
    });

    switch (outcome.kind) {
      case 'ok': {
        const accessToken = await this.tokens.signAccessToken({
          sub: outcome.userId,
          sid: outcome.sessionId,
        });
        return { ...outcome, accessToken };
      }
      case 'rotated':
        throw Errors.auth.refreshTokenRotated();
      case 'reused':
        this.logger.warn(
          `Phát hiện refresh token bị dùng lại → thu hồi phiên ${outcome.sessionId}`,
        );
        throw Errors.auth.refreshTokenReused();
      case 'invalid':
        throw Errors.auth.refreshTokenInvalid();
    }
  }

  /** @returns false nếu phiên không tồn tại, không thuộc user này, hoặc đã bị thu hồi từ trước. */
  revoke(sessionId: string, userId: string, reason: SessionRevokedReason): Promise<boolean> {
    return this.repo.revokeSession({ sessionId, userId, reason, at: new Date() });
  }

  revokeAll(userId: string): Promise<number> {
    return this.repo.revokeAllSessions(userId, 'logout_all', new Date());
  }

  /** Phiên còn sống, mới dùng gần nhất trước. */
  listActive(userId: string): Promise<SessionRow[]> {
    return this.repo.listActive(userId);
  }

  isActive(sessionId: string, userId: string): Promise<boolean> {
    return this.repo.isActive(sessionId, userId);
  }
}
