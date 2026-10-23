import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../../infra/database/database.module.js';
import type { Database } from '../../../infra/database/database.types.js';
import { AuditService } from '../../audit/audit.service.js';
import type { AuditContext } from '../../audit/audit.types.js';
import type { PurgedChannel, PurgeOptions } from '../channels.types.js';
import { ChannelsRepository } from '../repositories/channels.repository.js';

/** Thao tác của hệ thống (job) — audit ghi `actor_id = NULL`. */
const SYSTEM: AuditContext = { actorId: null };

/**
 * Xoá cứng kênh đã xoá mềm quá hạn, theo lô (M4). Worker chạy theo lịch 03:00 hằng ngày (M6 B8,
 * `MaintenanceJobRunner`).
 *
 * Gọi lặp tới khi trả về mảng rỗng. Nhiều worker gọi song song được: `SKIP LOCKED` chia việc.
 */
@Injectable()
export class ChannelsPurgeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repo: ChannelsRepository,
    private readonly audit: AuditService,
  ) {}

  async purgeBatch(options: PurgeOptions = {}): Promise<PurgedChannel[]> {
    const { limit = 100, retentionDays = 30, lockTimeoutMs = 5000 } = options;
    return this.db.transaction(async (tx) => {
      // BẪY: `SET LOCAL lock_timeout = $1` không nhận tham số bind (SET không phải câu lệnh có
      // tham số) → lỗi cú pháp. `set_config(..., is_local => true)` là hàm nên bind được, và chỉ
      // có hiệu lực trong transaction này.
      await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);

      const purged = await this.repo.purgeDeletedBatch({ limit, retentionDays }, tx);
      for (const channel of purged) {
        await this.audit.record(tx, SYSTEM, {
          orgId: channel.orgId,
          action: 'channel.purged',
          targetType: 'channel',
          targetId: channel.id,
          metadata: { before: { name: channel.name } },
        });
      }
      return purged;
    });
  }
}
