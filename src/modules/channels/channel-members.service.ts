import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-code.js';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database } from '../../infra/database/database.types.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository.js';
import { assertChannelTargetDecision, channelMemberNotFound } from './channel.errors.js';
import {
  canChangeChannelRole,
  canGrantChannelRole,
  canRemoveChannelMember,
  type GrantableChannelRole,
} from './channel.policy.js';
import { type ChannelMemberRow, ChannelMembersRepository } from './channel-members.repository.js';
import { ChannelsService } from './channels.service.js';
import {
  ChannelMemberResponseDto,
  type ListChannelMembersQueryDto,
} from './dto/channel-member.dto.js';
import type { ChannelAccess } from './guards/channel-access.js';

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
  ): Promise<ChannelMemberRow> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      const orgRole = await this.orgMembers.lockRoleForShare(access.orgId, userId, tx);
      if (!orgRole) throw AppException.notFound('Người này không phải thành viên tổ chức.');

      const { actorRole } = await this.channels.lockForAction(access, 'channel.member.add', tx);
      if (!canGrantChannelRole(actorRole, role)) {
        throw AppException.forbidden('QTV kênh chỉ thêm được thành viên hoặc khách.');
      }

      const inserted = await this.repo.insertIfAbsent(
        { channelId, orgId: access.orgId, userId, role },
        tx,
      );
      if (!inserted) {
        throw AppException.conflict(ErrorCode.ChannelAlreadyMember, 'Người này đã ở trong kênh.');
      }
      await this.audit.record(tx, ctx, {
        orgId: access.orgId,
        action: 'channel.member.added',
        targetType: 'channel',
        targetId: channelId,
        metadata: { userId, after: { role } },
      });
    });
    return this.findOrFail(channelId, userId);
  }

  /** Bậc 2 → bậc 3: khoá kênh, rồi khoá dòng thành viên đích, rồi mới hỏi policy theo đối tượng. */
  async changeRole(
    access: ChannelAccess,
    userId: string,
    newRole: GrantableChannelRole,
    ctx: UserAuditContext,
  ): Promise<ChannelMemberRow> {
    const channelId = access.channel.id;
    await this.db.transaction(async (tx) => {
      const { actorRole } = await this.channels.lockForAction(
        access,
        'channel.member.role.change',
        tx,
      );
      const target = await this.repo.lockMember(channelId, userId, tx);
      if (!target) throw channelMemberNotFound();
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
      if (!target) throw channelMemberNotFound();
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
  }

  /** Đọc lại sau commit để trả response; người đó vừa bị gỡ ngay sau đó thì 404 là đúng sự thật. */
  private async findOrFail(channelId: string, userId: string): Promise<ChannelMemberRow> {
    const row = await this.repo.findMember(channelId, userId);
    if (!row) throw channelMemberNotFound();
    return row;
  }
}

function decodeMemberCursor(cursor: string): [string, string] {
  const [joinedAt, userId] = decodeCursor(cursor, 2);
  return [expectTimestampKey(joinedAt), expectUuidKey(userId)];
}
