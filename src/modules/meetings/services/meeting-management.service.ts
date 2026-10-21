import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, Transaction } from '../../../infra/database/database.types.js';
import type { MeetingRow } from '../../../infra/database/schema/index.js';
import { AuditService } from '../../audit/audit.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import type { UpdateMeetingDto } from '../dto/update-meeting.dto.js';
import { canManageMeeting } from '../meeting.policy.js';
import type { MeetingPatch } from '../meetings.types.js';
import { MeetingsRepository } from '../repositories/meetings.repository.js';

/**
 * Sửa / xoá meeting (M6b B6). Khoá dòng meeting `FOR UPDATE` (bậc 4) rồi KIỂM TRA LẠI: meeting có
 * thể vừa bị xoá, hoặc vừa mất chủ (chủ rời org) giữa lúc gọi.
 */
@Injectable()
export class MeetingManagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: MeetingsRepository,
    private readonly audit: AuditService,
  ) {}

  async update(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    meetingId: string,
    dto: UpdateMeetingDto,
  ): Promise<void> {
    const patch: MeetingPatch = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.recordedAt !== undefined && { recordedAt: new Date(dto.recordedAt) }),
    };
    // Body rỗng vẫn đi qua kiểm quyền: trả đúng 403 / 404 như một lần sửa thật, chỉ không ghi.
    await this.db.transaction(async (tx) => {
      await this.lockManageable(membership, ctx.actorId, meetingId, tx);
      if (Object.keys(patch).length > 0) await this.repo.update(meetingId, patch, tx);
    });
  }

  /**
   * Xoá MỀM (Q6). OrgAdm xoá meeting KHÔNG chủ là thao tác quản trị → audit trong CÙNG transaction;
   * chủ tự xoá meeting của mình thì không. Gọi lại → 404 (đã xoá = không tồn tại với mọi người).
   */
  async remove(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    meetingId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const meeting = await this.lockManageable(membership, ctx.actorId, meetingId, tx);
      await this.repo.softDelete(meetingId, tx);
      if (meeting.ownerId !== ctx.actorId) {
        await this.audit.record(tx, ctx, {
          orgId: membership.orgId,
          action: 'meeting.deleted',
          targetType: 'meeting',
          targetId: meetingId,
          metadata: { before: { title: meeting.title, ownerId: meeting.ownerId } },
        });
      }
    });
  }

  private async lockManageable(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
    tx: Transaction,
  ): Promise<MeetingRow> {
    const meeting = await this.repo.lockForUpdate(membership.orgId, meetingId, tx);
    if (!meeting) throw Errors.meeting.notFound();
    await this.assertCanManage(meeting, membership, userId);
    return meeting;
  }

  /** Không quản lý được: XEM được → 403, không xem được → 404 (403 sẽ xác nhận meeting tồn tại). */
  private async assertCanManage(
    meeting: MeetingRow,
    membership: OrgMembershipContext,
    userId: string,
  ): Promise<void> {
    const viewer = { userId, orgRole: membership.role };
    if (canManageMeeting(meeting, viewer)) return;
    const visible = await this.repo.findVisible(membership.orgId, viewer, meeting.id);
    throw visible ? Errors.meeting.notManager() : Errors.meeting.notFound();
  }
}
