import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { type InviteRole, organizationJoinRequests } from '../../infra/database/schema/index.js';

@Injectable()
export class JoinRequestsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * `ON CONFLICT DO NOTHING` dựa vào partial unique index "một yêu cầu pending / (org, user)":
   * request trùng không lỗi 23505 mà trả về rỗng → service tự chọn mã lỗi nghiệp vụ.
   */
  async insertPending(
    values: { orgId: string; userId: string; inviteId: string; role: InviteRole },
    executor: DbExecutor,
  ): Promise<{ id: string } | undefined> {
    const [row] = await executor
      .insert(organizationJoinRequests)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: organizationJoinRequests.id });
    return row;
  }
}
