import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { UserRow } from '../../infra/database/schema/index.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../users/users.repository.js';
import { SessionResponseDto } from './dto/session-response.dto.js';

@Injectable()
export class MeService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
  ) {}

  async get(user: AuthUser): Promise<UserRow> {
    const row = await this.users.findById(user.id);
    // Guard đã kiểm tra phiên còn sống, nên trường hợp này chỉ xảy ra khi user vừa bị xoá.
    if (!row) throw AppException.notFound('Không tìm thấy người dùng.');
    return row;
  }

  async updateDisplayName(user: AuthUser, displayName: string): Promise<UserRow> {
    const row = await this.users.updateDisplayName(user.id, displayName);
    if (!row) throw AppException.notFound('Không tìm thấy người dùng.');
    return row;
  }

  async listSessions(user: AuthUser): Promise<SessionResponseDto[]> {
    const rows = await this.sessions.listActive(user.id);
    return rows.map((row) => SessionResponseDto.from(row, user.sessionId));
  }

  /**
   * Phiên không tồn tại, của người khác, hoặc đã bị thu hồi → 404 như nhau: không cho biết
   * một session id của người khác có tồn tại hay không.
   */
  async revokeSession(user: AuthUser, sessionId: string): Promise<void> {
    const revoked = await this.sessions.revoke(sessionId, user.id, 'revoked_by_user');
    if (!revoked) throw AppException.notFound('Không tìm thấy phiên đăng nhập.');
  }
}
