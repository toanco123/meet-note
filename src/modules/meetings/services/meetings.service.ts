import { Inject, Injectable, Logger } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../../common/pagination/keys.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import type { MeetingRow } from '../../../infra/database/schema/index.js';
import { RealtimeRoom } from '../../../infra/realtime/realtime-rooms.js';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import { channelPolicy, decideChannelPermission } from '../../channels/channel.policy.js';
import { assertChannelDecision } from '../../channels/channel-decisions.js';
import type { ChannelAccess } from '../../channels/channels.types.js';
import { ChannelsRepository } from '../../channels/repositories/channels.repository.js';
import type { OrgMembershipContext } from '../../organizations/organizations.types.js';
import type { ListMeetingsQueryDto } from '../dto/list-meetings-query.dto.js';
import type { CursorQueryDto } from '../../../common/pagination/cursor-query.dto.js';
import {
  ChannelMeetingResponseDto,
  MeetingDetailResponseDto,
  MeetingResponseDto,
} from '../dto/meeting-response.dto.js';
import { MeetingsRepository } from '../repositories/meetings.repository.js';
import type { MeetingViewer, PipelineScheduler } from '../meetings.types.js';
import { PIPELINE_SCHEDULER } from '../pipeline.tokens.js';

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    private readonly repo: MeetingsRepository,
    private readonly channels: ChannelsRepository,
    @Inject(PIPELINE_SCHEDULER) private readonly pipeline: PipelineScheduler,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  /** Chi tiết theo quyền xem (04 §3). Không xem được = không tồn tại → 404. */
  async getVisible(
    membership: OrgMembershipContext,
    userId: string,
    meetingId: string,
  ): Promise<MeetingDetailResponseDto> {
    const viewer = viewerOf(membership, userId);
    const meeting = await this.repo.findVisible(membership.orgId, viewer, meetingId);
    if (!meeting) throw Errors.meeting.notFound();
    const channels = await this.repo.listVisibleChannels(meeting.id, viewer);
    return MeetingDetailResponseDto.withChannels(meeting, channels);
  }

  async list(
    membership: OrgMembershipContext,
    userId: string,
    query: ListMeetingsQueryDto,
  ): Promise<Page<MeetingResponseDto>> {
    if (query.channelId)
      await this.assertChannelContentReadable(membership, userId, query.channelId);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
    const rows = await this.repo.listVisible({
      orgId: membership.orgId,
      viewer: viewerOf(membership, userId),
      channelId: query.channelId,
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      after: after && { recordedAt: expectTimestampKey(after[0]), id: expectUuidKey(after[1]) },
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.recordedAtKey, row.id]);
    return {
      data: page.data.map((row) => MeetingResponseDto.from(row)),
      nextCursor: page.nextCursor,
    };
  }

  /** Meeting trong kênh — `access` do ChannelAccessGuard + `channel.content.read` cấp. */
  async listByChannel(
    access: ChannelAccess,
    query: CursorQueryDto,
  ): Promise<Page<ChannelMeetingResponseDto>> {
    const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
    const rows = await this.repo.listByChannel({
      orgId: access.orgId,
      channelId: access.channel.id,
      after: after && {
        sharedAt: expectTimestampKey(after[0]),
        meetingId: expectUuidKey(after[1]),
      },
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.sharedAtKey, row.id]);
    return {
      data: page.data.map((row) => ChannelMeetingResponseDto.fromShared(row)),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Lọc theo kênh mà không kiểm quyền kênh = LỘ nội dung kênh riêng tư: người xem thấy meeting M qua
   * một kênh công khai, lọc `channelId` = kênh riêng tư K mình không ở trong → biết M nằm trong K.
   * Cùng quyết định với route `/channels/:id/...` của M4: không thấy kênh → 404; OrgAdm thấy
   * metadata nhưng không đọc nội dung kênh riêng tư → 403.
   */
  private async assertChannelContentReadable(
    membership: OrgMembershipContext,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const row = await this.channels.findAccess(membership.orgId, channelId, userId);
    if (!row) throw Errors.channel.notFound();
    const access: ChannelAccess = {
      orgId: membership.orgId,
      userId,
      orgRole: membership.role,
      channelRole: row.channelRole,
      channel: { id: row.id, visibility: row.visibility, archivedAt: row.archivedAt },
    };
    if (!channelPolicy['channel.read'](access)) throw Errors.channel.notFound();
    assertChannelDecision(decideChannelPermission('channel.content.read', access));
  }

  /**
   * Gợi ý realtime "trạng thái meeting vừa đổi" (05 Realtime, M7 B6) — gọi SAU COMMIT, như enqueue.
   * Tới `user:{chủ}` (chủ thấy ngay meeting mới, chưa ai kịp subscribe) và `meeting:{id}` (người đang
   * theo dõi). Payload nhỏ: client cần chi tiết thì gọi REST (02 §2). Pipeline M6 gọi lại hàm này
   * ở mỗi lần chuyển trạng thái.
   */
  publishStatus(meeting: Pick<MeetingRow, 'id' | 'ownerId' | 'status' | 'failureCode'>): void {
    const rooms = [RealtimeRoom.meeting(meeting.id)];
    if (meeting.ownerId) rooms.push(RealtimeRoom.user(meeting.ownerId));
    this.realtime.emit(rooms, 'meeting.status', {
      meetingId: meeting.id,
      status: meeting.status,
      failureCode: meeting.failureCode,
    });
  }

  /**
   * Gọi SAU KHI transaction tạo meeting đã COMMIT. Enqueue trong transaction mà transaction rollback
   * → job "ma" trỏ tới meeting không tồn tại; enqueue trước commit → worker đọc DB khi dòng chưa có.
   *
   * Enqueue lỗi (Redis sập) → KHÔNG ném: meeting đã được tạo, client nhận kết quả. Meeting nằm ở
   * `queued` không có job; gọi lại complete sẽ enqueue lại (jobId trùng → BullMQ bỏ qua nếu đã có),
   * và từ M6 job quét meeting `queued` quá 5 phút làm việc này ("outbox nghèo", 06-flows §1.1).
   */
  async enqueuePreprocess(meeting: MeetingRow, requestId: string | null): Promise<void> {
    if (meeting.status !== 'queued') return;
    try {
      await this.pipeline.enqueue('preprocess', {
        meetingId: meeting.id,
        attempt: meeting.attempt,
        requestId,
      });
    } catch (error) {
      this.logger.error({ err: error, meetingId: meeting.id }, 'Enqueue meeting.preprocess lỗi');
    }
  }
}

function viewerOf(membership: OrgMembershipContext, userId: string): MeetingViewer {
  return { userId, orgRole: membership.role };
}
