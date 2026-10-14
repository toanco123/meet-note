import { Test } from '@nestjs/testing';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import {
  auditLogs,
  channelMembers,
  channels,
} from '../../../../src/infra/database/schema/index.js';
import { AuditService } from '../../../../src/modules/audit/audit.service.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
import { ChannelsPurgeService } from '../../../../src/modules/channels/services/channels-purge.service.js';
import { insertChannel, insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { outcomeOf } from '../../../support/locks.js';

/**
 * Dọn dẹp kênh đã xoá mềm (`purgeBatch`). Lưu ý: purge quét TOÀN database → mỗi test tự tạo dữ liệu
 * của mình; database của file test này là bản clone riêng nên không đụng file khác.
 */
describe('Dọn dẹp kênh đã xoá mềm (Postgres thật)', () => {
  let t: TestDb;
  let service: ChannelsPurgeService;

  beforeAll(async () => {
    t = createTestDb(5);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChannelsPurgeService,
        ChannelsRepository,
        AuditService,
        { provide: DRIZZLE, useValue: t.db },
      ],
    }).compile();
    service = moduleRef.get(ChannelsPurgeService);
  });

  afterAll(async () => {
    await t.close();
  });

  /** `count` kênh xoá mềm cách đây `daysAgo` ngày; kênh thứ i cũ hơn kênh i+1 (thứ tự xác định). */
  async function seedDeleted(count: number, daysAgo: number): Promise<string[]> {
    const owner = await insertUser(t.db);
    const org = await insertOrg(t.db, owner.id);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const channel = await insertChannel(t.db, org.id, owner.id);
      await t.db
        .update(channels)
        .set({
          deletedAt: sql`now() - make_interval(days => ${daysAgo}::int, mins => ${count - i}::int)`,
        })
        .where(eq(channels.id, channel.id));
      ids.push(channel.id);
    }
    return ids;
  }

  const existing = async (ids: string[]) =>
    (await t.db.select({ id: channels.id }).from(channels).where(inArray(channels.id, ids))).map(
      (r) => r.id,
    );

  it('chỉ xoá cứng kênh xoá mềm quá 30 ngày; cascade thành viên; audit hệ thống', async () => {
    const old = await seedDeleted(3, 31);
    const recent = await seedDeleted(2, 1);
    const owner = await insertUser(t.db);
    const active = await insertChannel(t.db, (await insertOrg(t.db, owner.id)).id, owner.id);

    const purged = await service.purgeBatch();

    expect(purged.map((c) => c.id).sort()).toEqual([...old].sort());
    expect((await existing([...old, ...recent, active.id])).sort()).toEqual(
      [...recent, active.id].sort(),
    );
    const orphanMembers = await t.db
      .select()
      .from(channelMembers)
      .where(inArray(channelMembers.channelId, old));
    expect(orphanMembers).toEqual([]);
    const logs = await t.db
      .select({ actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'channel.purged'), inArray(auditLogs.targetId, old)));
    expect(logs).toEqual(old.map(() => ({ actorId: null })));
  });

  /**
   * HAI WORKER CÙNG LÚC — xác định, không phụ thuộc thời gian:
   *   A (worker đang làm dở) giữ khoá 5 kênh cũ nhất, chưa commit.
   *   B gọi `purgeBatch({ limit: 5, lockTimeoutMs: 200 })`.
   * Có `SKIP LOCKED`: B bỏ qua 5 dòng đang bị khoá, lấy NGAY 5 kênh kế tiếp.
   * Đột biến bỏ `SKIP LOCKED`: B đứng đợi dòng của A → quá `lock_timeout` → `pg:55P03`.
   */
  it('2 worker song song: B lấy ngay lô KHÁC lô A đang giữ, không đợi, không trùng', async () => {
    const old = await seedDeleted(10, 40);
    const held = Promise.withResolvers<string[]>();
    const release = Promise.withResolvers<void>();

    const workerA = t.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(inArray(channels.id, old))
        .orderBy(asc(channels.deletedAt))
        .limit(5)
        .for('update');
      held.resolve(locked.map((r) => r.id));
      await release.promise;
    });

    const lockedByA = await held.promise;
    const purgedByB = await service.purgeBatch({ limit: 5, lockTimeoutMs: 200 }).then(
      (rows) => rows.map((r) => r.id).sort(),
      (error: unknown) => outcomeOf(Promise.reject(error)),
    );
    release.resolve();
    await workerA;

    expect(lockedByA).toEqual(old.slice(0, 5));
    expect(purgedByB).toEqual(old.slice(5).sort());
    expect((await existing(old)).sort()).toEqual([...lockedByA].sort());
  });
});
