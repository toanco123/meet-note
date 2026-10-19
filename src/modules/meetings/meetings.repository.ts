import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE } from '../../infra/database/database.module.js';
import type { Database, DbExecutor } from '../../infra/database/database.types.js';
import { type MeetingRow, meetings } from '../../infra/database/schema/index.js';

@Injectable()
export class MeetingsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insert(values: typeof meetings.$inferInsert, executor: DbExecutor): Promise<MeetingRow> {
    const [row] = await executor.insert(meetings).values(values).returning();
    if (!row) throw new Error('INSERT meetings không trả về dòng nào');
    return row;
  }

  async findById(meetingId: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.id, meetingId));
    return row;
  }

  /** M5: chỉ chủ meeting xem được. M6 thay bằng điều kiện "xem được" dùng chung (04 §3). */
  async findOwned(
    orgId: string,
    ownerId: string,
    meetingId: string,
  ): Promise<MeetingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.orgId, orgId),
          eq(meetings.ownerId, ownerId),
          isNull(meetings.deletedAt),
        ),
      );
    return row;
  }
}
