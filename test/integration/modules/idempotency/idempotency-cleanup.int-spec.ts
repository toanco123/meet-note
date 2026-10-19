import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyKeys } from '../../../../src/infra/database/schema/index.js';
import { IdempotencyRepository } from '../../../../src/modules/idempotency/idempotency.repository.js';
import { insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { interleave } from '../../../support/locks.js';

/** Dọn `idempotency_keys` hết hạn. Database riêng của file này → đếm toàn bảng được. */
describe('Dọn idempotency_keys hết hạn (Postgres thật)', () => {
  let t: TestDb;
  let repo: IdempotencyRepository;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb(5);
    repo = new IdempotencyRepository(t.db);
    userId = (await insertUser(t.db)).id;
  });

  afterAll(async () => {
    await t.close();
  });

  /** `expiresInSeconds` âm = đã hết hạn. */
  function insertKey(key: string, expiresInSeconds: number, status: 'processing' | 'completed') {
    return t.db.insert(idempotencyKeys).values({
      userId,
      key,
      method: 'POST',
      path: '/v1/x',
      requestHash: 'cũ',
      status,
      responseStatus: status === 'completed' ? 201 : null,
      responseBody: status === 'completed' ? { id: key } : null,
      expiresAt: sql`now() + make_interval(secs => ${expiresInSeconds})`,
    });
  }
  const keysLeft = async () =>
    (await t.db.select({ key: idempotencyKeys.key }).from(idempotencyKeys))
      .map((r) => r.key)
      .sort();
  const byKey = (key: string) =>
    and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));

  it('chỉ xoá dòng hết hạn (cả completed lẫn processing bỏ dở), theo lô; gọi lặp tới 0', async () => {
    await insertKey('hết-1', -60, 'completed');
    await insertKey('hết-2', -50, 'completed');
    await insertKey('hết-3', -40, 'completed');
    await insertKey('bỏ-dở', -30, 'processing');
    await insertKey('còn-1', 3600, 'completed');
    await insertKey('còn-2', 3600, 'processing');

    const batches = [
      await repo.deleteExpiredBatch(3),
      await repo.deleteExpiredBatch(3),
      await repo.deleteExpiredBatch(3),
    ];

    expect([batches, await keysLeft()]).toEqual([
      [3, 1, 0],
      ['còn-1', 'còn-2'],
    ]);
  });

  // Đột biến bỏ `SKIP LOCKED` → lô dọn đứng đợi dòng đang bị khoá → 'đợi khoá'.
  it('dòng đang bị khoá → bỏ qua, xoá phần còn lại ngay, không đứng đợi', async () => {
    await insertKey('đang-khoá', -10, 'completed');
    await insertKey('tự-do', -10, 'completed');
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = t.db.transaction(async (tx) => {
      await tx.select().from(idempotencyKeys).where(byKey('đang-khoá')).for('update');
      held.resolve();
      await release.promise;
    });
    await held.promise;

    const deleted = await Promise.race([
      repo.deleteExpiredBatch(),
      new Promise((resolve) => setTimeout(() => resolve('đợi khoá'), 1000)),
    ]);
    release.resolve();
    await holder;

    expect([deleted, (await keysLeft()).includes('đang-khoá')]).toEqual([1, true]);
    await repo.deleteExpiredBatch();
  });

  /**
   * Dọn ‖ giữ chỗ lại CÙNG một key hết hạn: `claim` gặp dòng đang bị khoá để xoá → CHỜ; dòng biến
   * mất → Postgres thử lại nhánh `ON CONFLICT` từ đầu → INSERT như key mới. Không có `23505` lọt ra,
   * không mất lượt giữ chỗ.
   */
  it('dọn ‖ giữ chỗ lại cùng key → giữ chỗ chờ, rồi INSERT như key mới (không lỗi trùng khoá)', async () => {
    await insertKey('đua', -10, 'completed');

    const outcome = await interleave(t.db, {
      hold: (tx) => tx.select().from(idempotencyKeys).where(byKey('đua')).for('update'),
      contend: () =>
        repo.claim({ userId, key: 'đua', method: 'POST', path: '/v1/x', requestHash: 'mới' }),
      afterWait: (tx) => tx.delete(idempotencyKeys).where(byKey('đua')),
    });
    const row = await repo.find(userId, 'đua');

    expect([outcome, row?.status, row?.requestHash]).toEqual([
      { holder: 'OK', contender: 'OK' },
      'processing',
      'mới',
    ]);
  });
});
