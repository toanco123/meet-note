import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/errors.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, Transaction } from '../../infra/database/database.types.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import type { ListMembersQueryDto } from './dto/list-members-query.dto.js';
import { MemberResponseDto } from './dto/member-response.dto.js';
import type { AssignableOrgRole } from './dto/update-member-role.dto.js';
import { canChangeRole, canRemoveMember, OrgRole } from './organization.policy.js';
import { OrganizationMembersRepository } from './organization-members.repository.js';
import type { Page } from '../../common/pagination/pagination.types.js';
import type { TargetDecision } from './organizations.types.js';

@Injectable()
export class OrganizationMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: OrganizationMembersRepository,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, query: ListMembersQueryDto): Promise<Page<MemberResponseDto>> {
    const after = query.cursor ? decodeMemberCursor(query.cursor) : undefined;
    const rows = await this.repo.list({
      orgId,
      q: query.q,
      role: query.role,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.joinedAtKey, row.userId]);
    return {
      data: page.data.map((row) => MemberResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Mẫu "đổi quyền": khoá (actor, target) theo thứ tự → kiểm tra LẠI bằng policy trên dữ liệu
   * vừa khoá (guard đọc lúc đầu có thể đã cũ) → ghi. Mọi lỗi xảy ra TRƯỚC lệnh ghi nên ném
   * ngay trong transaction là an toàn (khác `SessionsService.rotate`, nơi có ghi rồi mới báo lỗi).
   */
  async changeRole(
    orgId: string,
    targetId: string,
    newRole: AssignableOrgRole,
    ctx: UserAuditContext,
  ): Promise<MemberResponseDto> {
    await this.db.transaction(async (tx) => {
      const { actor, target } = await this.lockActorAndTarget(orgId, ctx.actorId, targetId, tx);
      assertAllowed(canChangeRole(actor, target, newRole));
      if (target === newRole) return; // không đổi gì → không ghi audit
      await this.repo.updateRole(orgId, targetId, newRole, tx);
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.member.role_changed',
        targetType: 'member',
        targetId,
        metadata: { before: { role: target }, after: { role: newRole } },
      });
    });

    const updated = await this.repo.findMember(orgId, targetId);
    if (!updated) throw Errors.org.memberNotFound(); // bị gỡ ngay sau khi commit — hiếm, nhưng đừng trả 500
    return MemberResponseDto.from(updated);
  }

  /**
   * Gỡ thành viên. Cùng mẫu khoá với `changeRole` → hai thao tác chạm cùng người được tuần tự hoá:
   * thao tác đến sau đọc vai trò MỚI (vd B vừa thành admin) rồi mới quyết định.
   *
   * M4: khi đã có kênh, phải chuyển các kênh mà người bị gỡ làm chủ sang người khác TRONG cùng
   * transaction này (cascade FK sẽ xoá luôn dòng chủ kênh → kênh mồ côi).
   */
  async remove(orgId: string, targetId: string, ctx: UserAuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { actor, target } = await this.lockActorAndTarget(orgId, ctx.actorId, targetId, tx);
      assertAllowed(canRemoveMember(actor, target));
      await this.repo.deleteMember(orgId, targetId, tx);
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.member.removed',
        targetType: 'member',
        targetId,
        metadata: { before: { role: target } },
      });
    });
  }

  /**
   * Chuyển quyền sở hữu. Khoá (owner, người nhận) theo user_id → kiểm tra LẠI người gọi còn là owner
   * (request song song có thể vừa chuyển đi) → HẠ owner cũ TRƯỚC, NÂNG người nhận SAU: partial unique
   * index "một owner / org" không deferrable, làm ngược sẽ có lúc 2 owner → 23505.
   */
  async transferOwnership(
    orgId: string,
    newOwnerId: string,
    ctx: UserAuditContext,
  ): Promise<{ orgId: string; ownerId: string }> {
    if (newOwnerId === ctx.actorId) {
      throw Errors.org.transferToSelf();
    }

    await this.db.transaction(async (tx) => {
      const { actor, target } = await this.lockActorAndTarget(orgId, ctx.actorId, newOwnerId, tx);
      if (actor !== OrgRole.Owner) {
        throw Errors.org.noLongerOwner();
      }

      await this.repo.updateRole(orgId, ctx.actorId, OrgRole.Admin, tx); // 1. hạ
      await this.repo.updateRole(orgId, newOwnerId, OrgRole.Owner, tx); //  2. nâng
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.ownership.transferred',
        targetType: 'member',
        targetId: newOwnerId,
        metadata: {
          before: { ownerId: ctx.actorId, newOwnerRole: target },
          after: { ownerId: newOwnerId, previousOwnerRole: OrgRole.Admin },
        },
      });
    });
    return { orgId, ownerId: newOwnerId };
  }

  /**
   * Tự rời tổ chức. Owner phải chuyển quyền sở hữu trước (409) — org không bao giờ mất owner.
   * M4: phải chuyển các kênh người này làm chủ trong cùng transaction (như `remove`).
   */
  async leave(orgId: string, ctx: UserAuditContext): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [self] = await this.repo.lockMembers(orgId, [ctx.actorId], tx);
      if (!self) throw Errors.org.notFound();
      if (self.role === OrgRole.Owner) {
        throw Errors.org.ownerMustTransfer();
      }
      await this.repo.deleteMember(orgId, ctx.actorId, tx);
      await this.audit.record(tx, ctx, {
        orgId,
        action: 'org.member.left',
        targetType: 'member',
        targetId: ctx.actorId,
        metadata: { before: { role: self.role } },
      });
    });
  }

  private async lockActorAndTarget(
    orgId: string,
    actorId: string,
    targetId: string,
    tx: Transaction,
  ) {
    const rows = await this.repo.lockMembers(orgId, [actorId, targetId], tx);
    const actor = rows.find((r) => r.userId === actorId)?.role;
    const target = rows.find((r) => r.userId === targetId)?.role;
    // Actor vừa bị gỡ bởi request khác (sau khi guard đã cho qua) → coi như không còn là thành viên.
    if (!actor) throw Errors.org.notFound();
    if (!target) throw Errors.org.memberNotFound();
    return { actor, target };
  }
}

function assertAllowed(decision: TargetDecision): void {
  if (decision === 'owner_immutable') {
    throw Errors.org.ownerImmutable();
  }
  if (decision === 'forbidden') {
    throw Errors.role.cannotActOn();
  }
}

/** Kiểm tra từng khoá trước khi chạm SQL — cursor bị sửa tay → 400, không phải 500. */
function decodeMemberCursor(cursor: string): [string, string] {
  const [joinedAtKey, userId] = decodeCursor(cursor, 2);
  return [expectTimestampKey(joinedAtKey), expectUuidKey(userId)];
}
