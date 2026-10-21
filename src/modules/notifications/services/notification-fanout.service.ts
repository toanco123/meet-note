import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { JobName, notificationFanoutJobId } from '../../../infra/queue/jobs.js';
import { QueueName } from '../../../infra/queue/queue.module.js';
import type { NotificationFanoutJobData } from '../../../infra/queue/queue.types.js';
import { NotificationsRepository } from '../notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/** Người nhận mỗi lô: một INSERT nhiều dòng + một lượt đẩy realtime. */
const FANOUT_BATCH = 500;

/**
 * Thông báo NHIỀU người nhận (M10 Q2): request chỉ enqueue SAU commit; worker tạo thông báo theo lô.
 * Transaction của share không dài ra theo số thành viên kênh, đổi lại thông báo tới trễ vài trăm ms.
 *
 * Idempotent nhờ `dedupe_key` (`ON CONFLICT DO NOTHING`): job chạy lại — retry sau lỗi giữa chừng,
 * job bị stalled — chỉ tạo phần còn thiếu, và chỉ đẩy realtime cho các dòng VỪA tạo.
 */
@Injectable()
export class NotificationFanoutService {
  private readonly logger = new Logger(NotificationFanoutService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly notifications: NotificationsService,
    @InjectQueue(QueueName.Default) private readonly queue: Queue<NotificationFanoutJobData>,
  ) {}

  /**
   * Gọi SAU commit share — kể cả share lặp lại (200): enqueue lần trước có thể đã lỗi, gọi lại cùng
   * jobId thì BullMQ bỏ qua nếu job đã có. Enqueue lỗi (Redis sập) → chỉ log: share đã commit.
   */
  async enqueueMeetingShared(
    meetingId: string,
    channelId: string,
    sharedAt: Date,
    requestId: string | null,
  ): Promise<void> {
    try {
      await this.queue.add(
        JobName.NotificationFanout,
        { type: 'meeting.shared', meetingId, channelId, requestId },
        {
          jobId: notificationFanoutJobId(meetingSharedKey(meetingId, channelId), sharedAt),
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );
    } catch (error) {
      this.logger.error({ err: error, meetingId, channelId }, 'Enqueue notification.fanout lỗi');
    }
  }

  /** Worker gọi. Trả số thông báo VỪA tạo (0 nếu share không còn, hoặc job chạy lại khi đã đủ). */
  async run(data: NotificationFanoutJobData, batchSize = FANOUT_BATCH): Promise<number> {
    const { meetingId, channelId } = data;
    const share = await this.repo.findLiveShare(meetingId, channelId);
    if (!share) return 0;
    const actorId = share.sharedBy;
    const actorName = actorId
      ? ((await this.repo.displayNames([actorId])).get(actorId) ?? null)
      : null;
    const payload = {
      meetingId,
      meetingTitle: share.meetingTitle,
      channelId,
      channelName: share.channelName,
      actorId,
      actorName,
    };

    let created = 0;
    let afterUserId: string | null = null;
    for (;;) {
      const userIds = await this.repo.fanoutRecipients({
        meetingId,
        channelId,
        excludeUserId: actorId,
        afterUserId,
        limit: batchSize,
      });
      if (userIds.length === 0) break;
      // Không bọc transaction: mỗi lô tự đứng được nhờ dedupe — lỗi ở lô 3 thì lô 1–2 giữ nguyên,
      // lần retry chỉ bù phần thiếu. Người vừa rời tổ chức giữa SELECT và INSERT → FK 23503 → job
      // lỗi → retry không còn chọn người đó.
      const rows = await this.repo.insertMany(
        userIds.map((userId) => ({
          userId,
          orgId: share.orgId,
          type: 'meeting.shared' as const,
          payload,
          dedupeKey: meetingSharedKey(meetingId, channelId),
        })),
      );
      this.notifications.publish(rows);
      created += rows.length;
      if (userIds.length < batchSize) break;
      afterUserId = userIds.at(-1) ?? null;
    }
    return created;
  }
}

/** `dedupe_key` — mỗi người nhận một lần cho mỗi cặp (meeting, kênh). Không có `:` (đuôi jobId). */
function meetingSharedKey(meetingId: string, channelId: string): string {
  return `meeting-shared.${meetingId}.${channelId}`;
}
