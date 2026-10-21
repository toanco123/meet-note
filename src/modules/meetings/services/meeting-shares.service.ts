import { Inject, Injectable } from '@nestjs/common';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import { Errors } from '../../../common/errors/errors.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, Transaction } from '../../../infra/database/database.types.js';
import { assertChannelDecision } from '../../channels/channel-decisions.js';
import { channelPolicy, decideChannelPermission } from '../../channels/channel.policy.js';
import type { ChannelAccess } from '../../channels/channels.types.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import { MeetingShareResponseDto } from '../dto/meeting-share.dto.js';
import { decideUnshare } from '../meeting.policy.js';
import { MeetingSharesRepository } from '../repositories/meeting-shares.repository.js';
import { MeetingsRepository } from '../repositories/meetings.repository.js';

/**
 * Share / gỡ share meeting vào kênh (M6b). Mẫu "dùng quyền": khoá theo thứ tự chung, KIỂM TRA LẠI
 * trên dữ liệu vừa khoá, rồi mới ghi. Không có audit: thao tác nội dung, không phải quản trị.
 */
@Injectable()
export class MeetingSharesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: MeetingSharesRepository,
    private readonly meetings: MeetingsRepository,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  /** Lần đầu `created: true` (201); đã share từ trước → `false` (200, cùng nội dung — Q3). */
  async share(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
    channelId: string,
  ): Promise<{ share: MeetingShareResponseDto; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const access = await this.lockChannelAccess(membership, userId, channelId, tx);
      const meeting = await this.repo.lockMeeting(membership.orgId, meetingId, tx); // bậc 4
      // Chỉ share meeting CỦA MÌNH; của người khác → 404 như không tồn tại (không nói "có nhưng
      // không phải của bạn").
      if (!meeting || meeting.ownerId !== userId) throw Errors.meeting.notFound();
      assertChannelDecision(decideChannelPermission('channel.meeting.share', access));

      const values = { meetingId, channelId, orgId: membership.orgId, sharedBy: userId };
      const inserted = await this.repo.insert(values, tx);
      const sharedAt =
        inserted?.sharedAt ?? (await this.repo.find(meetingId, channelId, tx))?.sharedAt;
      if (!sharedAt) throw new Error('meeting_shares: vừa ON CONFLICT mà không đọc lại được dòng');
      return {
        share: { meetingId, channelId, sharedAt: sharedAt.toISOString() },
        created: inserted !== undefined,
      };
    });
  }

  /** Idempotent: chưa share / đã gỡ → vẫn 204 (với người có quyền). */
  async unshare(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
    channelId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const access = await this.lockChannelAccess(membership, userId, channelId, tx);
      const meeting = await this.repo.lockMeeting(membership.orgId, meetingId, tx); // bậc 4
      if (!meeting) throw Errors.meeting.notFound();

      const decision = decideUnshare({
        channelRole: access.channelRole,
        orgRole: membership.role,
        channelArchived: access.channel.archivedAt !== null,
        isMeetingOwner: meeting.ownerId === userId,
        meetingOwnerless: meeting.ownerId === null,
      });
      // Không có quyền VÀ cũng không xem được meeting → 404: 403 sẽ xác nhận meeting tồn tại.
      if (decision === 'forbidden') {
        const viewer = { userId, orgRole: membership.role };
        const visible = await this.meetings.findVisible(membership.orgId, viewer, meetingId);
        if (!visible) throw Errors.meeting.notFound();
      }
      assertChannelDecision(decision);
      await this.repo.remove(meetingId, channelId, tx);
    });
    // Sau commit: người xem chỉ thấy meeting qua kênh vừa gỡ → rời room meeting (M7 Q2).
    this.realtime.revalidateAccess({ kind: 'meeting', meetingId });
  }

  /**
   * Bậc 2 → 3: khoá kênh rồi dòng thành viên của người gọi; không THẤY kênh (đã xoá, riêng tư mà
   * không ở trong, không phải OrgAdm) → 404 như M4.
   */
  private async lockChannelAccess(
    membership: OrgMembershipContext,
    userId: string,
    channelId: string,
    tx: Transaction,
  ): Promise<ChannelAccess> {
    const channel = await this.repo.lockChannel(membership.orgId, channelId, tx);
    if (!channel) throw Errors.channel.notFound();
    const channelRole = await this.repo.lockChannelRole(channelId, userId, tx);
    const access: ChannelAccess = {
      orgId: membership.orgId,
      userId,
      orgRole: membership.role,
      channelRole,
      channel,
    };
    if (!channelPolicy['channel.read'](access)) throw Errors.channel.notFound();
    return access;
  }
}
