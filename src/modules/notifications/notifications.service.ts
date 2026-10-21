import { Inject, Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../infra/database/database.types.js';
import type { NotificationRow } from '../../infra/database/schema/index.js';
import { RealtimeRoom } from '../../infra/realtime/realtime-rooms.js';
import { REALTIME_PUBLISHER } from '../../infra/realtime/realtime.module.js';
import type { RealtimePublisher } from '../../infra/realtime/realtime.types.js';
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import { NotificationsRepository } from './notifications.repository.js';
import type { NotificationDraft } from './notifications.types.js';

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
}
