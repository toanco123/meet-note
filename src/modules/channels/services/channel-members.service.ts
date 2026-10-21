import { Inject, Injectable } from '@nestjs/common';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../../common/pagination/keys.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import { AuditService } from '../../audit/audit.service.js';
import { NotificationsService } from '../../notifications/services/notifications.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { OrganizationMembersRepository } from '../../organizations/repositories/organization-members.repository.js';
import { assertChannelTargetDecision } from '../channel-decisions.js';
import {
  canChangeChannelRole,
  canGrantChannelRole,
  canReceiveChannelOwnership,
  canRemoveChannelMember,
  ChannelRole,
} from '../channel.policy.js';
import { ChannelMembersRepository } from '../repositories/channel-members.repository.js';
import { ChannelsService } from './channels.service.js';
import {
  ChannelMemberResponseDto,
  type ListChannelMembersQueryDto,
} from '../dto/channel-member.dto.js';
import { Errors } from '../../../common/errors/errors.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import type {
  ChannelAccess,
  ChannelMemberListRow,
  GrantableChannelRole,
} from '../channels.types.js';

/**
 * Mọi thao tác ghi đi theo THỨ TỰ KHOÁ CHUNG (03-database §7):
 *   1. organization_members  2. channels (mutex của kênh)  3. channel_members
 * Không bao giờ khoá ngược bậc → hai thao tác bất kỳ chạm cùng dữ liệu chỉ có thể chờ nhau một
 * chiều, không vòng tròn, không deadlock.
 */
@Injectable()
export class ChannelMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ChannelMembersRepository,
    private readonly channels: ChannelsService,
    private readonly orgMembers: OrganizationMembersRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  async list(
    channelId: string,
    query: ListChannelMembersQueryDto,
  ): Promise<Page<ChannelMemberResponseDto>> {
    const after = query.cursor ? decodeMemberCursor(query.cursor) : undefined;
    const rows = await this.repo.list({
      channelId,
      q: query.q,
      role: query.role,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.joinedAtKey, row.userId]);
    return {
      data: page.data.map((row) => ChannelMemberResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Bậc 1: khoá `FOR SHARE` dòng TỔ CHỨC của người được thêm → họ không thể bị gỡ khỏi org giữa
   * chừng (gỡ cần `FOR UPDATE` → phải đợi). Đồng thời cho 404 rõ ràng thay vì để composite FK
   * `channel_members_org_member_fk` nổ 23503 → 409 CONFLICT chung chung.
   * Bậc 2: khoá kênh + kiểm tra lại quyền. Rồi mới INSERT.
   */
  async add(
    access: ChannelAccess,
    userId: string,
    role: GrantableChannelRole,
    ctx: UserAuditContext,
  ): Promise<ChannelMemberListRow> {
    const channelId = access.channel.id;
    const created = await this.db.transaction(async (tx) => {
      const orgRole = await this.orgMembers.lockRoleForShare(access.orgId, userId, tx);
      if (!orgRole) throw Errors.org.memberNotFound();

      const { channel, actorRole } = await this.channels.lockForAction(
        access,
        'channel.member.add',
        tx,
      );
      if (!canGrantChannelRole(actorRole, role)) {
        throw Errors.role.cannotGrant();
      }

      const inserted = await this.repo.insertIfAbsent(
        { channelId, orgId: access.orgId, userId, role },
        tx,
      );
      if (!inserted) {
        throw Errors.channel.alreadyMember();
      }
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.added',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId, after: { role } },
      });
      // Thông báo trong CÙNG transaction (M10 Q2): thêm thất bại → không có thông báo "ma".
      const names = await this.notifications.displayNames([ctx.actorId], tx);
      return this.notifications.recordInTx(tx, [
        {
          userId,
          orgId: access.orgId,
          type: 'channel.member_added',
          payload: {
            channelId,
            channelName: channel.name,
            role,
            actorId: ctx.actorId,
            actorName: names.get(ctx.actorId) ?? '',
          },
        },
      ]);
    });
    this.notifications.publish(created); // SAU commit
    return this.findOrFail(channelId, userId);
  }

  /** Bậc 2 → bậc 3: khoá kênh, rồi khoá dòng thành viên đích, rồi mới hỏi policy theo đối tượng. */
  async changeRole(
    access: ChannelAccess,
    userId: string,
    newRole: GrantableChannelRole,
    ctx: UserAuditContext,
  ): Promise<ChannelMemberListRow> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      const { actorRole } = await this.channels.lockForAction(
        access,
        'channel.member.role.change',
        tx,
      );
      const target = await this.repo.lockMember(channelId, userId, tx);
      if (!target) throw Errors.channel.memberNotFound();
      assertChannelTargetDecision(canChangeChannelRole(actorRole, target, newRole));
      if (target === newRole) return; // không đổi gì → không ghi audit

      await this.repo.updateRole(channelId, userId, newRole, tx);
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.role_changed',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId, before: { role: target }, after: { role: newRole } },
      });
    });
    return this.findOrFail(channelId, userId);
  }

  async remove(access: ChannelAccess, userId: string, ctx: UserAuditContext): Promise<void> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      const { actorRole } = await this.channels.lockForAction(access, 'channel.member.remove', tx);
      const target = await this.repo.lockMember(channelId, userId, tx);
      if (!target) throw Errors.channel.memberNotFound();
      assertChannelTargetDecision(canRemoveChannelMember(actorRole, target));

      await this.repo.deleteMember(channelId, userId, tx);
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.removed',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId, before: { role: target } },
      });
    });
    this.realtime.revalidateAccess({ kind: 'user', userId });
  }

  /**
   * Tự tham gia kênh công khai. Cùng thứ tự khoá với `add`: dòng tổ chức của mình `FOR SHARE`
   * (bậc 1) → kênh (bậc 2, kiểm tra lại: kênh vẫn công khai, chưa lưu trữ) → INSERT.
   */
  async join(access: ChannelAccess, ctx: UserAuditContext): Promise<void> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      const orgRole = await this.orgMembers.lockRoleForShare(access.orgId, ctx.actorId, tx);
      if (!orgRole) throw Errors.org.notFound();
      await this.channels.lockForAction(access, 'channel.join', tx, orgRole);

      const inserted = await this.repo.insertIfAbsent(
        { channelId, orgId: access.orgId, userId: ctx.actorId, role: 'member' },
        tx,
      );
      if (!inserted) throw Errors.channel.alreadyJoined();
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.joined',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId: ctx.actorId, after: { role: 'member' } },
      });
    });
  }

  /**
   * Tự rời kênh. Kênh lưu trữ vẫn cho rời (không ai bị kẹt). Chủ kênh phải chuyển chủ trước:
   * kiểm tra trên dòng VỪA KHOÁ — một transfer song song có thể vừa biến người này thành chủ.
   */
  async leave(access: ChannelAccess, ctx: UserAuditContext): Promise<void> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      await this.channels.lockForAction(access, 'channel.leave', tx);
      const role = await this.repo.lockMember(channelId, ctx.actorId, tx);
      if (!role) throw Errors.channel.memberNotFound();
      if (role === ChannelRole.Owner) throw Errors.channel.ownerMustTransfer();

      await this.repo.deleteMember(channelId, ctx.actorId, tx);
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.left',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId: ctx.actorId, before: { role } },
      });
    });
    this.realtime.revalidateAccess({ kind: 'user', userId: ctx.actorId });
  }

  /**
   * Chuyển chủ kênh (CO, hoặc OrgAdm chuyển hộ) — đúng THỨ TỰ KHOÁ CHUNG, từng bậc:
   *
   * 1. `organization_members` của người gọi + người nhận, `FOR SHARE`, theo `user_id`: người nhận
   *    không bị gỡ khỏi org giữa chừng; vai trò OrgAdm của người gọi giữ nguyên tới lúc commit.
   * 2. `channels` (mutex của kênh) + kiểm tra lại quyền với vai trò org VỪA KHOÁ.
   * 3. `channel_members` của chủ hiện tại + người nhận, `FOR UPDATE`, theo `user_id`.
   *
   * Đảo bậc 1 xuống cuối → "gỡ X khỏi org ‖ chuyển cho X" chờ nhau vòng tròn → 40P01 (race test).
   * Ghi: HẠ chủ cũ trước, NÂNG chủ mới sau — partial unique index "một chủ / kênh" không deferrable.
   */
  async transferOwnership(
    access: ChannelAccess,
    newOwnerId: string,
    ctx: UserAuditContext,
  ): Promise<{ channelId: string; ownerId: string }> {
    const channelId = access.channel.id;
    const created = await this.db.transaction(async (tx) => {
      // Bậc 1
      const orgRows = await this.orgMembers.lockRolesForShare(
        access.orgId,
        [ctx.actorId, newOwnerId],
        tx,
      );
      const actorOrgRole = orgRows.find((r) => r.userId === ctx.actorId)?.role;
      if (!actorOrgRole) throw Errors.org.notFound();
      if (!orgRows.some((r) => r.userId === newOwnerId)) throw Errors.org.memberNotFound();

      // Bậc 2
      const { channel } = await this.channels.lockForAction(
        access,
        'channel.ownership.transfer',
        tx,
        actorOrgRole,
      );

      // Bậc 3
      const rows = await this.repo.lockOwnerAndMember(channelId, newOwnerId, tx);
      const target = rows.find((r) => r.userId === newOwnerId)?.role ?? null;
      if (target === null) throw Errors.channel.memberNotFound();
      if (!canReceiveChannelOwnership(target)) {
        throw target === ChannelRole.Owner
          ? Errors.channel.transferToCurrentOwner()
          : Errors.channel.transferToGuest();
      }
      const oldOwner = rows.find((r) => r.role === ChannelRole.Owner);

      if (oldOwner) await this.repo.updateRole(channelId, oldOwner.userId, ChannelRole.Admin, tx);
      await this.repo.updateRole(channelId, newOwnerId, ChannelRole.Owner, tx);
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.ownership.transferred',
        targetType: 'channel',
        targetId: channelId,
        metadata: {
          before: { ownerId: oldOwner?.userId ?? null, newOwnerRole: target },
          after: { ownerId: newOwnerId, previousOwnerRole: ChannelRole.Admin },
        },
      });
      // Chủ mới + chủ cũ, trừ chính người thực hiện (CO tự chuyển → chỉ chủ mới nhận; OrgAdm chuyển
      // hộ → cả hai nhận).
      const previousOwnerId = oldOwner?.userId ?? null;
      const recipients = [newOwnerId, previousOwnerId].filter(
        (id): id is string => id !== null && id !== ctx.actorId,
      );
      const names = await this.notifications.displayNames(
        [ctx.actorId, newOwnerId, ...(previousOwnerId ? [previousOwnerId] : [])],
        tx,
      );
      return this.notifications.recordInTx(
        tx,
        recipients.map((recipient) => ({
          userId: recipient,
          orgId: access.orgId,
          type: 'channel.ownership_transferred' as const,
          payload: {
            channelId,
            channelName: channel.name,
            newOwnerId,
            newOwnerName: names.get(newOwnerId) ?? '',
            previousOwnerId,
            previousOwnerName: previousOwnerId ? (names.get(previousOwnerId) ?? '') : null,
            actorId: ctx.actorId,
            actorName: names.get(ctx.actorId) ?? '',
          },
        })),
      );
    });
    this.notifications.publish(created); // SAU commit
    return { channelId, ownerId: newOwnerId };
  }

  /** Đọc lại sau commit để trả response; người đó vừa bị gỡ ngay sau đó thì 404 là đúng sự thật. */
  private async findOrFail(channelId: string, userId: string): Promise<ChannelMemberListRow> {
    const row = await this.repo.findMember(channelId, userId);
    if (!row) throw Errors.channel.memberNotFound();
    return row;
  }
}

function decodeMemberCursor(cursor: string): [string, string] {
  const [joinedAt, userId] = decodeCursor(cursor, 2);
  return [expectTimestampKey(joinedAt), expectUuidKey(userId)];
}
