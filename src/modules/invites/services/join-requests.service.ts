import { Inject, Injectable } from '@nestjs/common';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../../common/pagination/keys.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, Transaction } from '../../../infra/database/database.types.js';
import { AuditService } from '../../audit/audit.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { canGrantRole } from '../../organizations/organization.policy.js';
import { OrganizationMembersRepository } from '../../organizations/repositories/organization-members.repository.js';
import {
  type JoinRequestDecisionResponseDto,
  JoinRequestResponseDto,
  type ListJoinRequestsQueryDto,
} from '../dto/join-request.dto.js';
import { JoinRequestsRepository } from '../repositories/join-requests.repository.js';
import { Errors } from '../../../common/errors/errors.js';
import type { Page } from '../../../common/pagination/pagination.types.js';

@Injectable()
export class JoinRequestsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: JoinRequestsRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    orgId: string,
    query: ListJoinRequestsQueryDto,
  ): Promise<Page<JoinRequestResponseDto>> {
    const after = query.cursor ? decodeRequestCursor(query.cursor) : undefined;
    const rows = await this.repo.list(orgId, query.status, after, query.limit);
    const page = toPage(rows, query.limit, (row) => [row.createdAtKey, row.id]);
    return {
      data: page.data.map((row) => JoinRequestResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Thứ tự khoá: dòng yêu cầu (FOR UPDATE) → vai trò người duyệt (FOR SHARE). Duyệt = cấp vai trò
   * → cùng quy tắc `canGrantRole` như tạo link: Admin không duyệt được yêu cầu vào với vai trò admin.
   */
  async approve(
    orgId: string,
    requestId: string,
    ctx: UserAuditContext,
  ): Promise<JoinRequestDecisionResponseDto> {
    const created = await this.db.transaction(async (tx) => {
      const request = await this.lockPending(orgId, requestId, tx);
      const actorRole = await this.members.lockRoleForShare(orgId, ctx.actorId, tx);
      if (!actorRole) throw Errors.org.notFound();
      if (!canGrantRole(actorRole, request.role)) {
        throw Errors.role.cannotGrant();
      }

      // Người này có thể đã vào bằng đường khác trong lúc chờ → không lỗi, vẫn đánh dấu đã duyệt.
      await this.members.insertIfAbsent({ orgId, userId: request.userId, role: request.role }, tx);
      await this.repo.decide(
        requestId,
        { status: 'approved', decidedBy: ctx.actorId, decidedAt: new Date() },
        tx,
      );
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.join_request.approved',
        targetType: 'join_request',
        targetId: requestId,
        metadata: { userId: request.userId, after: { role: request.role } },
      });
      // Người xin vào ĐÃ là thành viên trong transaction này → FK (org_id, user_id) của thông báo hợp lệ.
      return this.notifications.recordInTx(tx, [
        {
          userId: request.userId,
          orgId,
          type: 'org.join_request_approved',
          payload: { orgName: await this.notifications.orgName(orgId, tx), role: request.role },
          dedupeKey: `join-request-approved.${requestId}`,
        },
      ]);
    });
    this.notifications.publish(created); // SAU commit
    return { id: requestId, status: 'approved' };
  }

  async reject(
    orgId: string,
    requestId: string,
    ctx: UserAuditContext,
  ): Promise<JoinRequestDecisionResponseDto> {
    return this.db.transaction(async (tx) => {
      const request = await this.lockPending(orgId, requestId, tx);
      await this.repo.decide(
        requestId,
        { status: 'rejected', decidedBy: ctx.actorId, decidedAt: new Date() },
        tx,
      );
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.join_request.rejected',
        targetType: 'join_request',
        targetId: requestId,
        metadata: { userId: request.userId },
      });
      return { id: requestId, status: 'rejected' };
    });
  }

  private async lockPending(orgId: string, requestId: string, tx: Transaction) {
    const request = await this.repo.lockInOrg(orgId, requestId, tx);
    if (!request) throw Errors.joinRequest.notFound();
    if (request.status !== 'pending') {
      throw Errors.joinRequest.notPending();
    }
    return request;
  }
}

function decodeRequestCursor(cursor: string): [string, string] {
  const [createdAtKey, id] = decodeCursor(cursor, 2);
  return [expectTimestampKey(createdAtKey), expectUuidKey(id)];
}
