import { Inject, Injectable, Logger } from '@nestjs/common';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import { Errors } from '../../../common/errors/errors.js';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database, Transaction } from '../../../infra/database/database.types.js';
import type { MeetingRow } from '../../../infra/database/schema/index.js';
import { AuditService } from '../../audit/audit.service.js';
import type { UserAuditContext } from '../../audit/audit.types.js';
import { StatsScheduler } from '../../dashboard/stats.scheduler.js';
import { localDate } from '../../reports/report-week.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import type { UpdateMeetingDto } from '../dto/update-meeting.dto.js';
import { canManageMeeting } from '../meeting.policy.js';
import { publishMeetingStatus } from '../meeting-events.js';
import type { MeetingPatch, PipelineScheduler } from '../meetings.types.js';
import { PIPELINE_SCHEDULER } from '../pipeline.tokens.js';
import { MeetingsRepository } from '../repositories/meetings.repository.js';

/**
 * Sửa / xoá meeting (M6b B6). Khoá dòng meeting `FOR UPDATE` (bậc 4) rồi KIỂM TRA LẠI: meeting có
 * thể vừa bị xoá, hoặc vừa mất chủ (chủ rời org) giữa lúc gọi.
 */
@Injectable()
export class MeetingManagementService {
  private readonly logger = new Logger(MeetingManagementService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: MeetingsRepository,
    private readonly audit: AuditService,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
    @Inject(PIPELINE_SCHEDULER) private readonly pipeline: PipelineScheduler,
    private readonly stats: StatsScheduler,
  ) {}

  /**
   * Chạy lại meeting `failed` (M6 B7): khoá dòng → KIỂM LẠI `failed` (hai lần bấm song song: lần sau
   * chờ khoá rồi thấy `queued` → 409) → `attempt + 1`, `queued` → COMMIT → enqueue `…a<attempt mới>`
   * + phát `meeting.status`. Cùng quyền như sửa; OrgAdm chạy lại meeting không chủ → audit.
   */
  async retry(
    membership: OrgMembershipContext,
    ctx: UserAuditContext,
    meetingId: string,
  ): Promise<void> {
    const meeting = await this.db.transaction(async (tx) => {
      const current = await this.lockManageable(membership, ctx.actorId, meetingId, tx);
      if (current.status !== 'failed') throw Errors.meeting.notFailed();
      const reset = await this.repo.resetForRetry(meetingId, tx);
      if (current.ownerId !== ctx.actorId) {
        await this.audit.record(tx, ctx, {
          orgId: membership.orgId,
          action: 'meeting.retried',
          targetType: 'meeting',
          targetId: meetingId,
          metadata: { attempt: reset.attempt, failureCode: current.failureCode },
        });
      }
      return reset;
    });
    publishMeetingStatus(this.realtime, meeting);
    // Enqueue lỗi (Redis sập) → meeting nằm `queued` không job: quét meeting kẹt (B8) enqueue lại.
    await this.pipeline
      .enqueue('preprocess', {
        meetingId,
        attempt: meeting.attempt,
        requestId: ctx.requestId ?? null,
      })
      .catch((error: unknown) =>
        this.logger.error({ err: error, meetingId }, 'Enqueue chạy lại lỗi'),
      );
  }

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
    const before = await this.db.transaction(async (tx) => {
      const current = await this.lockManageable(membership, ctx.actorId, meetingId, tx);
      if (Object.keys(patch).length > 0) await this.repo.update(meetingId, patch, tx);
      return current;
    });
    // Chuyển meeting sang NGÀY khác: rollup của ngày cũ không tự biết (tick chỉ thấy ngày mới) → cả hai.
    // Cùng ngày VN thì số liệu không đổi (thời lượng / trạng thái giữ nguyên) → không xếp job.
    if (patch.recordedAt) {
      const [from, to] = [localDate(before.recordedAt), localDate(patch.recordedAt)];
      if (from !== to) await this.refreshStats(membership.orgId, [from, to], ctx.requestId ?? null);
    }
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
    const deleted = await this.db.transaction(async (tx) => {
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
      return meeting;
    });
    this.realtime.revalidateAccess({ kind: 'meeting', meetingId });
    await this.refreshStats(
      membership.orgId,
      [localDate(deleted.recordedAt)],
      ctx.requestId ?? null,
    );
  }

  /**
   * Báo rollup dashboard tính lại các ngày vừa đổi — SAU commit (enqueue trước commit thì worker có thể
   * đọc nguồn cũ). Lỗi enqueue (Redis sập) KHÔNG làm hỏng thao tác của người dùng: job đêm (03:30)
   * tính lại 35 ngày gần nhất nên số liệu tự lành.
   */
  private async refreshStats(orgId: string, days: string[], requestId: string | null) {
    for (const day of days) {
      await this.stats
        .enqueueDayChanged(orgId, day, requestId)
        .catch((error: unknown) =>
          this.logger.error({ err: error, orgId, day }, 'Enqueue rollup dashboard lỗi'),
        );
    }
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
