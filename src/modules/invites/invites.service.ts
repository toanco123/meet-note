import { Inject, Injectable } from '@nestjs/common';
import { generateOpaqueToken } from '../../common/crypto/opaque-token.js';
import { AppException } from '../../common/errors/app.exception.js';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import type { CursorQueryDto } from '../../common/pagination/cursor-query.dto.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { canGrantRole } from '../organizations/organization.policy.js';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository.js';
import type { CreateInviteDto } from './dto/create-invite.dto.js';
import { CreatedInviteResponseDto, InviteResponseDto } from './dto/invite-response.dto.js';
import { InvitesRepository } from './invites.repository.js';

@Injectable()
export class InvitesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: InvitesRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tạo link = cấp quyền vào org với một vai trò → kiểm tra `canGrantRole` trên vai trò ĐÃ KHOÁ
   * `FOR SHARE` của người tạo: nếu đúng lúc đó Owner hạ người này xuống member, một trong hai phải đợi.
   */
  async create(
    orgId: string,
    dto: CreateInviteDto,
    ctx: UserAuditContext,
  ): Promise<CreatedInviteResponseDto> {
    const { token, hash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + dto.expiresInHours * 3_600_000);

    const row = await this.db.transaction(async (tx) => {
      const actorRole = await this.members.lockRoleForShare(orgId, ctx.actorId, tx);
      if (!actorRole) throw AppException.notFound('Không tìm thấy tổ chức.');
      if (!canGrantRole(actorRole, dto.role)) {
        throw AppException.forbidden('Bạn không thể tạo link cấp vai trò ngang hoặc cao hơn mình.');
      }

      const invite = await this.repo.insert(
        {
          orgId,
          tokenHash: hash,
          role: dto.role,
          createdBy: ctx.actorId,
          expiresAt,
          maxUses: dto.maxUses ?? null,
        },
        tx,
      );
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.invite.created',
        targetType: 'invite',
        targetId: invite.id,
        // KHÔNG ghi token (dù là hash) vào audit: log đọc được bởi nhiều người hơn bảng invites.
        metadata: { after: { role: invite.role, expiresAt, maxUses: invite.maxUses } },
      });
      return invite;
    });

    return CreatedInviteResponseDto.withToken(row, token);
  }

  async list(orgId: string, query: CursorQueryDto): Promise<Page<InviteResponseDto>> {
    const after = query.cursor ? decodeInviteCursor(query.cursor) : undefined;
    const rows = await this.repo.list(orgId, after, query.limit);
    const page = toPage(rows, query.limit, (row) => [row.createdAtKey, row.id]);
    return {
      data: page.data.map((row) => InviteResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /** Thu hồi là idempotent: thu hồi link đã thu hồi → vẫn 204, không ghi audit lần hai. */
  async revoke(orgId: string, inviteId: string, ctx: UserAuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const invite = await this.repo.lockInOrg(orgId, inviteId, tx);
      if (!invite) throw AppException.notFound('Không tìm thấy link mời.');
      if (invite.revokedAt) return;

      await this.repo.markRevoked(inviteId, new Date(), tx);
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.invite.revoked',
        targetType: 'invite',
        targetId: inviteId,
      });
    });
  }
}

function decodeInviteCursor(cursor: string): [string, string] {
  const [createdAtKey, id] = decodeCursor(cursor, 2);
  return [expectTimestampKey(createdAtKey), expectUuidKey(id)];
}
