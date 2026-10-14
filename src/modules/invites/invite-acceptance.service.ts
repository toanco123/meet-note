import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { hashOpaqueToken, OPAQUE_TOKEN_PATTERN } from '../../common/crypto/opaque-token.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository.js';
import type {
  AcceptInviteResponseDto,
  InvitePreviewResponseDto,
} from './dto/invite-acceptance.dto.js';
import { inviteStatus } from './dto/invite-response.dto.js';
import { InvitesRepository } from './invites.repository.js';
import { JoinRequestsRepository } from './join-requests.repository.js';

@Injectable()
export class InviteAcceptanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly invites: InvitesRepository,
    private readonly joinRequests: JoinRequestsRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly audit: AuditService,
  ) {}

  async preview(token: string): Promise<InvitePreviewResponseDto> {
    const found = await this.findUsable(token, this.db);
    return {
      orgName: found.orgName,
      role: found.invite.role,
      expiresAt: found.invite.expiresAt.toISOString(),
      requiresApproval: found.requireJoinApproval,
    };
  }

  /**
   * Một transaction: trừ lượt (UPDATE có điều kiện) → vào thẳng hoặc tạo yêu cầu chờ duyệt → audit.
   * Bước sau thất bại (đã là thành viên, đã có yêu cầu chờ) → ném lỗi TRƯỚC khi commit → lượt
   * vừa trừ được hoàn lại. Lượt dùng tính lúc chấp nhận, kể cả khi cần duyệt (M3 Q2).
   */
  async accept(token: string, ctx: UserAuditContext): Promise<AcceptInviteResponseDto> {
    const hash = hashOrNotFound(token);

    return this.db.transaction(async (tx) => {
      const invite = await this.invites.consumeUse(hash, tx);
      if (!invite) {
        await this.findUsable(token, tx); // ném 404/410 đúng lý do
        throw inviteNotFound(); // phòng hờ: dòng vừa đổi trạng thái giữa hai câu lệnh
      }

      const found = await this.invites.findByHash(hash, tx);
      if (!found) throw inviteNotFound();

      if (!found.requireJoinApproval) {
        const joined = await this.members.insertIfAbsent(
          { orgId: invite.orgId, userId: ctx.actorId, role: invite.role },
          tx,
        );
        if (!joined) throw alreadyMember();
        await this.audit.record(tx, ctx, {
          orgId: invite.orgId,
          action: 'org.member.joined',
          targetType: 'member',
          targetId: ctx.actorId,
          metadata: { after: { role: invite.role }, inviteId: invite.id },
        });
        return { status: 'joined', orgId: invite.orgId };
      }

      return this.createJoinRequest(invite, ctx, tx);
    });
  }

  private async createJoinRequest(
    invite: { id: string; orgId: string; role: 'admin' | 'member' },
    ctx: UserAuditContext,
    tx: DbExecutor,
  ): Promise<AcceptInviteResponseDto> {
    if (await this.members.isMember(invite.orgId, ctx.actorId, tx)) throw alreadyMember();

    const request = await this.joinRequests.insertPending(
      { orgId: invite.orgId, userId: ctx.actorId, inviteId: invite.id, role: invite.role },
      tx,
    );
    if (!request) {
      throw AppException.conflict(
        ErrorCode.OrgJoinRequestPending,
        'Bạn đã có một yêu cầu tham gia đang chờ duyệt.',
      );
    }
    await this.audit.record(tx, ctx, {
      orgId: invite.orgId,
      action: 'org.join_request.created',
      targetType: 'join_request',
      targetId: request.id,
      metadata: { after: { role: invite.role }, inviteId: invite.id },
    });
    return { status: 'pending', orgId: invite.orgId, requestId: request.id };
  }

  /** Link dùng được → trả về; không → ném 404 (không có / đã thu hồi) hoặc 410 (hết hạn / hết lượt). */
  private async findUsable(token: string, executor: DbExecutor) {
    const found = await this.invites.findByHash(hashOrNotFound(token), executor);
    if (!found) throw inviteNotFound();

    switch (inviteStatus(found.invite)) {
      case 'revoked':
        throw inviteNotFound(); // với người nhận, link bị thu hồi = link không tồn tại
      case 'expired':
        throw new AppException(ErrorCode.InviteExpired, HttpStatus.GONE, 'Link mời đã hết hạn.');
      case 'exhausted':
        throw new AppException(ErrorCode.InviteExhausted, HttpStatus.GONE, 'Link mời đã hết lượt.');
      case 'active':
        return found;
    }
  }
}

/** Token sai định dạng → 404 ngay, không tốn một lần tra DB. */
function hashOrNotFound(token: string): Buffer {
  if (!OPAQUE_TOKEN_PATTERN.test(token)) throw inviteNotFound();
  return hashOpaqueToken(token);
}

function inviteNotFound(): AppException {
  return new AppException(
    ErrorCode.InviteNotFound,
    HttpStatus.NOT_FOUND,
    'Không tìm thấy link mời.',
  );
}

function alreadyMember(): AppException {
  return AppException.conflict(ErrorCode.OrgAlreadyMember, 'Bạn đã là thành viên của tổ chức này.');
}
