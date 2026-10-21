import { Inject, Injectable } from '@nestjs/common';
import { Errors } from '../../../common/errors/errors.js';
import { decodeCursor, toPage } from '../../../common/pagination/cursor.js';
import { expectTimestampKey, expectUuidKey } from '../../../common/pagination/keys.js';
import type { Page } from '../../../common/pagination/pagination.types.js';
import type { DbExecutor } from '../../../infra/database/database.types.js';
import type { NotificationRow } from '../../../infra/database/schema/index.js';
import { RealtimeRoom } from '../../../infra/realtime/realtime-rooms.js';
import { REALTIME_PUBLISHER } from '../../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../../infra/realtime/realtime.types.js';
import type {
  ListNotificationsQueryDto,
  UnreadCountResponseDto,
} from '../dto/notification-query.dto.js';
import { NotificationResponseDto } from '../dto/notification-response.dto.js';
import { NotificationsRepository } from '../notifications.repository.js';
import type { NotificationDraft, NotificationReadEvent } from '../notifications.types.js';

/** Đếm chưa đọc dừng ở đây; hiển thị `"99+"` (M10 Q5). */
const UNREAD_CAP = 100;

/**
 * Hai bước, như audit + enqueue (M10 Q2):
 * 1. `recordInTx` — TRONG transaction của thao tác: thao tác rollback thì không có thông báo "ma".
 * 2. `publish` — SAU commit: đẩy `notification.created` tới `user:{id}` (gợi ý realtime; người
 *    offline đọc lại qua REST — DB là nguồn sự thật).
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly repo: NotificationsRepository,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  /** Trả các dòng VỪA tạo (trùng `dedupe_key` → không trả) — giữ lại để `publish` sau commit. */
  recordInTx(tx: DbExecutor, drafts: NotificationDraft[]): Promise<NotificationRow[]> {
    return this.repo.insertMany(drafts, tx);
  }

  publish(rows: NotificationRow[]): void {
    for (const row of rows) {
      this.realtime.emit(
        [RealtimeRoom.user(row.userId)],
        'notification.created',
        NotificationResponseDto.from(row),
      );
    }
  }

  displayNames(userIds: string[], executor?: DbExecutor): Promise<Map<string, string>> {
    return this.repo.displayNames(userIds, executor);
  }

  orgName(orgId: string, executor?: DbExecutor): Promise<string> {
    return this.repo.orgName(orgId, executor);
  }

  async list(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<Page<NotificationResponseDto>> {
    const after = query.cursor ? decodeCursor(query.cursor, 2) : undefined;
    const rows = await this.repo.list({
      userId,
      orgId: query.orgId,
      unreadOnly: query.unreadOnly,
      after: after && { createdAt: expectTimestampKey(after[0]), id: expectUuidKey(after[1]) },
      limit: query.limit,
    });
    const page = toPage(rows, query.limit, (row) => [row.createdAtKey, row.id]);
    return {
      data: page.data.map((r) => NotificationResponseDto.from(r)),
      nextCursor: page.nextCursor,
    };
  }

  async unreadCount(userId: string, orgId: string | undefined): Promise<UnreadCountResponseDto> {
    const count = await this.repo.countUnread(userId, orgId, UNREAD_CAP);
    return { count, display: count >= UNREAD_CAP ? '99+' : String(count) };
  }

  /**
   * Của người khác / không tồn tại / đã xoá → 404 (tài nguyên ẩn). Đọc lại → vẫn 204 và vẫn phát
   * `notification.read` (client xử lý idempotent — không cần phân biệt "vừa đọc" với "đã đọc").
   */
  async markRead(userId: string, id: string): Promise<void> {
    if (!(await this.repo.markRead(userId, id))) throw Errors.notification.notFound();
    this.emitRead(userId, { ids: [id] });
  }

  /** Không có gì chưa đọc → không phát (tránh mọi thiết bị đi lấy lại số chưa đọc vô ích). */
  async markAllRead(userId: string, orgId: string | undefined): Promise<void> {
    if ((await this.repo.markAllRead(userId, orgId)) > 0) {
      this.emitRead(userId, { all: true, orgId: orgId ?? null });
    }
  }

  /** Câu UPDATE đã tự commit (không có transaction bao ngoài) → phát ngay sau đó là "sau commit". */
  private emitRead(userId: string, event: NotificationReadEvent): void {
    this.realtime.emit([RealtimeRoom.user(userId)], 'notification.read', event);
  }

  /** Xoá MỀM; xoá lại → vẫn 204. */
  async remove(userId: string, id: string): Promise<void> {
    if (!(await this.repo.softDelete(userId, id))) throw Errors.notification.notFound();
  }
}
