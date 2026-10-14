import { Inject, Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../common/errors/pg-error.js';
import { decodeCursor, type Page, toPage } from '../../common/pagination/cursor.js';
import { expectTextKey } from '../../common/pagination/keys.js';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, Transaction } from '../../infra/database/database.types.js';
import type { ChannelVisibility } from '../../infra/database/schema/index.js';
import { diffForAudit, isEmptyDiff } from '../audit/audit-diff.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserAuditContext } from '../audit/audit.types.js';
import {
  isOrgRoleAtLeast,
  type OrgMembershipContext,
  OrgRole,
} from '../organizations/organization.policy.js';
import { Errors } from '../../common/errors/errors.js';
import { assertChannelDecision } from './channel-decisions.js';
import { ChannelRole, type ChannelPermission, decideChannelPermission } from './channel.policy.js';
import {
  type ChannelDetailRow,
  type ChannelPatch,
  type LockedChannel,
  CHANNELS_ORG_NAME_UNIQUE,
  ChannelsRepository,
} from './channels.repository.js';
import { ChannelResponseDto } from './dto/channel-response.dto.js';
import type { ListChannelsQueryDto } from './dto/list-channels-query.dto.js';
import type { ChannelAccess } from './guards/channel-access.js';

/** `lower(name)` có thể dài hơn tên gốc vài ký tự với Unicode đặc biệt → chừa rộng. */
const MAX_NAME_KEY_LENGTH = 200;

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ChannelsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Kênh, dòng Chủ kênh và audit cùng một transaction: kênh không có chủ là trạng thái hỏng.
   *
   * Không kiểm tra "tên đã có chưa" bằng SELECT trước: hai request cùng tên chạy song song đều
   * thấy "chưa có" rồi cùng INSERT. Để unique index quyết định, rồi đổi 23505 thành 409.
   */
  async create(
    orgId: string,
    input: { name: string; description?: string; visibility?: ChannelVisibility },
    ctx: UserAuditContext,
  ): Promise<ChannelDetailRow> {
    const visibility = input.visibility ?? 'public';
    const { id } = await this.db
      .transaction(async (tx) => {
        const channel = await this.repo.insertChannel(
          {
            orgId,
            name: input.name,
            description: input.description ?? null,
            visibility,
            createdBy: ctx.actorId,
          },
          tx,
        );
        await this.repo.insertMember(
          { channelId: channel.id, orgId, userId: ctx.actorId, role: ChannelRole.Owner },
          tx,
        );
        await this.audit.record(tx, ctx, {
          orgId,
          action: 'channel.created',
          targetType: 'channel',
          targetId: channel.id,
          metadata: { after: { name: input.name, visibility } },
        });
        return channel;
      })
      .catch(mapNameTaken);
    return this.getDetail(id, ctx.actorId);
  }

  async list(
    membership: OrgMembershipContext,
    userId: string,
    query: ListChannelsQueryDto,
  ): Promise<Page<ChannelResponseDto>> {
    const after = query.cursor
      ? expectTextKey(decodeCursor(query.cursor, 1)[0], MAX_NAME_KEY_LENGTH)
      : undefined;
    const rows = await this.repo.list({
      orgId: membership.orgId,
      userId,
      seeAll: isOrgRoleAtLeast(membership.role, OrgRole.Admin),
      q: query.q,
      visibility: query.visibility,
      archived: query.archived,
      after,
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.nameKey]);
    return {
      data: page.data.map((row) => ChannelResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  async getDetail(channelId: string, userId: string): Promise<ChannelDetailRow> {
    const detail = await this.repo.findDetail(channelId, userId);
    // Guard đã thấy kênh; không còn nghĩa là kênh vừa bị xoá giữa chừng.
    if (!detail) throw Errors.channel.notFound();
    return detail;
  }

  /**
   * Bước đầu của MỌI thao tác ghi trên một kênh (sửa, thành viên, chuyển chủ, lưu trữ…):
   * khoá dòng kênh = mutex → đọc lại vai trò người gọi → hỏi lại policy trên dữ liệu VỪA KHOÁ.
   *
   * Guard đọc TRƯỚC khi khoá: giữa lúc đó kênh có thể vừa bị lưu trữ, hoặc người gọi vừa bị hạ
   * quyền. Mọi thay đổi vai trò trong kênh đều khoá dòng kênh này trước → sau khi khoá, vai trò
   * đọc được là vai trò mới nhất, không ai đổi được cho tới khi transaction này xong.
   */
  async lockForAction(
    access: ChannelAccess,
    permission: ChannelPermission,
    tx: Transaction,
  ): Promise<{ channel: LockedChannel; actorRole: ChannelRole | null }> {
    const channel = await this.repo.lockForUpdate(access.channel.id, tx);
    if (!channel) throw Errors.channel.notFound();
    const actorRole = await this.repo.findMemberRole(access.channel.id, access.userId, tx);
    assertChannelDecision(
      decideChannelPermission(permission, {
        channelRole: actorRole,
        orgRole: access.orgRole,
        channel,
      }),
    );
    return { channel, actorRole };
  }

  async update(
    access: ChannelAccess,
    patch: ChannelPatch,
    ctx: UserAuditContext,
  ): Promise<ChannelDetailRow> {
    const channelId = access.channel.id;
    await this.db
      .transaction(async (tx) => {
        const { channel: current } = await this.lockForAction(access, 'channel.update', tx);

        const changed = diffForAudit(current, patch);
        if (isEmptyDiff(changed)) return;

        await this.repo.update(channelId, changed.after, tx);
        await this.audit.record(tx, ctx, {
          orgId: access.orgId,
          action: 'channel.updated',
          targetType: 'channel',
          targetId: channelId,
          metadata: changed,
        });
      })
      .catch(mapNameTaken);
    return this.getDetail(channelId, ctx.actorId);
  }
}

/**
 * 23505 làm transaction bị huỷ (mọi lệnh sau đó đều lỗi 25P02) → không bắt BÊN TRONG transaction
 * rồi chạy tiếp được. Bắt ở NGOÀI, sau khi Drizzle đã rollback.
 */
function mapNameTaken(error: unknown): never {
  if (isUniqueViolation(error, CHANNELS_ORG_NAME_UNIQUE)) throw Errors.channel.nameTaken();
  throw error;
}
