import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { type UploadRow, uploads } from '../../../../src/infra/database/schema/index.js';
import { OBJECT_STORAGE } from '../../../../src/infra/storage/storage.module.js';
import { UploadsCleanupService } from '../../../../src/modules/uploads/services/uploads-cleanup.service.js';
import { UploadsRepository } from '../../../../src/modules/uploads/uploads.repository.js';
import { insertOrg, insertUpload, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { outcomeOf } from '../../../support/locks.js';
import { createTestStorage, isMultipartAlive } from '../../../support/storage.js';

/**
 * Dọn upload bỏ dở. Như purge kênh: job quét TOÀN database của file test này (bản clone riêng) →
 * mỗi test assert trên upload của chính nó.
 */
describe('Dọn upload bỏ dở (Postgres + RustFS thật)', () => {
  let t: TestDb;
  const s3 = createTestStorage();
  let service: UploadsCleanupService;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    t = createTestDb(5);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadsCleanupService,
        UploadsRepository,
        { provide: DRIZZLE, useValue: t.db },
        { provide: OBJECT_STORAGE, useValue: s3.storage },
      ],
    }).compile();
    service = moduleRef.get(UploadsCleanupService);
    userId = (await insertUser(t.db)).id;
    orgId = (await insertOrg(t.db, userId)).id;
  });

  afterAll(async () => {
    s3.close();
    await t.close();
  });

  /** Upload có multipart THẬT trên S3, hết hạn cách đây `expiredMinutesAgo` phút (âm = còn hạn). */
  async function seed(
    expiredMinutesAgo: number,
    overrides: Partial<typeof uploads.$inferInsert> = {},
  ): Promise<UploadRow> {
    const objectKey = `orgs/${orgId}/uploads/${randomUUID()}/source`;
    const { uploadId } = await s3.storage.createMultipartUpload(objectKey, 'audio/mp4');
    return insertUpload(t.db, orgId, userId, {
      objectKey,
      s3UploadId: uploadId,
      expiresAt: new Date(Date.now() - expiredMinutesAgo * 60_000),
      ...overrides,
    });
  }

  /** [status trong DB, đã ghi storage_aborted_at, multipart còn sống trên S3]. */
  async function stateOf(upload: UploadRow) {
    const [row] = await t.db.select().from(uploads).where(eq(uploads.id, upload.id));
    return [
      row?.status,
      row?.storageAbortedAt instanceof Date,
      await isMultipartAlive(s3.storage, upload.objectKey, upload.s3UploadId),
    ];
  }

  // Đột biến: bỏ điều kiện ân hạn → upload vừa hết hạn 3 phút bị dọn (có thể còn phần đang gửi).
  it('initiated quá hạn + ân hạn → expired, abort trên S3; còn hạn / trong ân hạn / đã huỷ → không đụng', async () => {
    const stale = await seed(30);
    const fresh = await seed(-60);
    const inGrace = await seed(3);
    const cancelled = await seed(30, { status: 'aborted' });

    const result = await service.expireBatch();

    expect(result).toEqual({
      processed: [stale.id],
      storageAborted: [stale.id],
      storageFailed: [],
    });
    expect(await Promise.all([stale, fresh, inGrace, cancelled].map(stateOf))).toEqual([
      ['expired', true, false],
      ['initiated', false, true],
      ['initiated', false, true],
      ['aborted', false, true], // việc của lượt thử abort lại, không phải của expireBatch
    ]);
  });

  /**
   * DB đánh dấu TRƯỚC, S3 abort SAU, ngoài transaction: S3 lỗi thì upload vẫn `expired` (không nhận
   * gì nữa) và được lượt thử lại gom — kể cả upload huỷ thủ công mà lúc huỷ S3 lỗi.
   * Đột biến: `listStorageAbortPending` chỉ lấy `expired` → upload huỷ thủ công mồ côi mãi.
   */
  it('S3 lỗi lúc abort → expired nhưng storage_aborted_at NULL, multipart còn; lượt thử lại abort được', async () => {
    const stale = await seed(30);
    const cancelled = await seed(30, { status: 'aborted' });
    vi.spyOn(s3.storage, 'abortMultipartUpload').mockRejectedValueOnce(new Error('S3 sập'));

    const first = await service.expireBatch();
    const afterFailure = await stateOf(stale);
    const retry = await service.retryStorageAbortBatch();

    expect([first.storageFailed, afterFailure]).toEqual([[stale.id], ['expired', false, true]]);
    expect(retry.storageAborted).toEqual(expect.arrayContaining([stale.id, cancelled.id]));
    expect(retry.storageFailed).toEqual([]);
    expect([await stateOf(stale), await stateOf(cancelled)]).toEqual([
      ['expired', true, false],
      ['aborted', true, false],
    ]);
  });

  /**
   * HAI WORKER CÙNG LÚC (như purge kênh M4): A giữ khoá 5 upload hết hạn lâu nhất, chưa commit
   * (cũng là hình dạng của một `complete` đang khoá dòng upload để gọi S3). B gọi `expireBatch`.
   * Có `SKIP LOCKED`: B lấy NGAY 5 upload kế tiếp. Đột biến bỏ `SKIP LOCKED`: B đợi A → `pg:55P03`.
   */
  it('2 worker song song: B lấy ngay lô KHÁC lô A đang giữ, không đợi, không trùng', async () => {
    const seeded: UploadRow[] = [];
    for (let i = 0; i < 10; i++) seeded.push(await seed(200 - i)); // i nhỏ = hết hạn lâu hơn
    const ids = seeded.map((u) => u.id);
    const held = Promise.withResolvers<string[]>();
    const release = Promise.withResolvers<void>();

    const workerA = t.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: uploads.id })
        .from(uploads)
        .where(inArray(uploads.id, ids))
        .orderBy(asc(uploads.expiresAt))
        .limit(5)
        .for('update');
      held.resolve(locked.map((r) => r.id));
      await release.promise;
    });

    const lockedByA = await held.promise;
    const byB = await service.expireBatch({ limit: 5, lockTimeoutMs: 200 }).then(
      (r) => [...r.processed].sort(),
      (error: unknown) => outcomeOf(Promise.reject(error)),
    );
    release.resolve();
    await workerA;
    const nextRun = await service.expireBatch({ limit: 5 });

    expect(lockedByA).toEqual(ids.slice(0, 5));
    expect(byB).toEqual(ids.slice(5).sort());
    // A buông khoá → lần chạy sau lấy nốt phần A từng giữ.
    expect([...nextRun.processed].sort()).toEqual(ids.slice(0, 5).sort());
  });
});
