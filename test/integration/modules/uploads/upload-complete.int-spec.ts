import { Readable } from 'node:stream';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { meetings, uploads } from '../../../../src/infra/database/schema/index.js';
import { QueueName } from '../../../../src/infra/queue/queue.module.js';
import { MultipartUploadNotFoundError } from '../../../../src/infra/storage/storage.errors.js';
import { OBJECT_STORAGE } from '../../../../src/infra/storage/storage.module.js';
import { MeetingsRepository } from '../../../../src/modules/meetings/meetings.repository.js';
import { MeetingsService } from '../../../../src/modules/meetings/meetings.service.js';
import { UploadsRepository } from '../../../../src/modules/uploads/uploads.repository.js';
import { UploadsCleanupService } from '../../../../src/modules/uploads/services/uploads-cleanup.service.js';
import {
  UPLOAD_CHUNK_BYTES,
  UploadsService,
} from '../../../../src/modules/uploads/services/uploads.service.js';
import { insertOrg, insertUser } from '../../../support/db-factories.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { outcomeOf } from '../../../support/locks.js';
import { createTestStorage } from '../../../support/storage.js';

const MiB = 1024 * 1024;

interface Enqueued {
  name: string;
  data: { meetingId: string; requestId: string | null };
  jobId: string;
  /** Lúc `add()` chạy, một connection KHÁC có thấy meeting không (= đã commit chưa). */
  meetingVisible: boolean;
}

/**
 * Complete upload với Postgres + RustFS thật và queue GIẢ có ghi chép. Mỗi test ghi chú đột biến
 * làm nó đỏ (kết quả trong plan M5).
 */
describe('UploadsService.complete (Postgres + RustFS thật)', () => {
  let t: TestDb;
  const s3 = createTestStorage();
  let service: UploadsService;
  let repo: UploadsRepository;
  const enqueued: Enqueued[] = [];
  const queue = {
    add: vi.fn<(name: string, data: Enqueued['data'], opts: { jobId: string }) => Promise<void>>(
      async (name, data, opts) => {
        const [row] = await t.db
          .select({ id: meetings.id })
          .from(meetings)
          .where(eq(meetings.id, data.meetingId));
        enqueued.push({ name, data, jobId: opts.jobId, meetingVisible: row !== undefined });
      },
    ),
  };

  beforeAll(async () => {
    t = createTestDb(8);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadsService,
        UploadsCleanupService,
        UploadsRepository,
        MeetingsRepository,
        MeetingsService,
        { provide: getQueueToken(QueueName.Default), useValue: queue },
        { provide: DRIZZLE, useValue: t.db },
        { provide: OBJECT_STORAGE, useValue: s3.storage },
      ],
    }).compile();
    service = moduleRef.get(UploadsService);
    repo = moduleRef.get(UploadsRepository);
  });

  afterAll(async () => {
    s3.close();
    await t.close();
  });

  /** Upload đã gửi đủ mọi phần, sẵn sàng complete. */
  async function readyUpload(sizeBytes: number) {
    const user = await insertUser(t.db);
    const org = await insertOrg(t.db, user.id);
    const { upload } = await service.init(org.id, user.id, {
      filename: 'a.m4a',
      mimeType: 'audio/mp4',
      sizeBytes,
      sha256: 'a'.repeat(64),
      title: 'Họp',
      recordedAt: '2026-10-19T02:00:00.000Z',
    });
    for (let n = 1; n <= upload.totalParts; n++) {
      const size =
        n < upload.totalParts
          ? UPLOAD_CHUNK_BYTES
          : sizeBytes - UPLOAD_CHUNK_BYTES * (upload.totalParts - 1);
      await service.uploadPart(org.id, user.id, upload.id, n, {
        body: Readable.from([Buffer.alloc(size)]),
        contentType: 'application/octet-stream',
        contentLength: String(size),
        signal: new AbortController().signal,
      });
    }
    const complete = () => service.complete(org.id, user.id, upload.id, 'req-1');
    const meetingCount = async () =>
      (await t.db.select({ n: count() }).from(meetings).where(eq(meetings.orgId, org.id)))[0]?.n;
    return { upload, complete, meetingCount };
  }

  // Đột biến: gọi enqueue BÊN TRONG transaction → lúc add() chạy connection khác chưa thấy meeting.
  it('enqueue SAU commit: lúc add() chạy meeting đã nhìn thấy từ connection khác; đúng jobId', async () => {
    const { complete } = await readyUpload(9 * MiB);
    enqueued.length = 0;

    const { meeting, created } = await complete();

    expect(created).toBe(true);
    expect(enqueued).toEqual([
      {
        name: 'meeting.preprocess',
        data: { meetingId: meeting.id, requestId: 'req-1' },
        jobId: `meeting.preprocess.${meeting.id}.a1`,
        meetingVisible: true,
      },
    ]);
  });

  // RustFS cho complete lại multipart đã ghép xong → thành công ngay ở S3 (đã thử trực tiếp).
  it('S3 đã ghép xong mà ghi DB lỗi → gọi lại complete vẫn tạo được meeting (RustFS)', async () => {
    const { upload, complete, meetingCount } = await readyUpload(6 * MiB);
    vi.spyOn(repo, 'markCompleted').mockRejectedValueOnce(new Error('DB lỗi sau khi S3 đã ghép'));

    await expect(complete()).rejects.toThrow('DB lỗi sau khi S3 đã ghép');
    const [afterFail] = await t.db.select().from(uploads).where(eq(uploads.id, upload.id));
    expect([
      afterFail?.status,
      await meetingCount(),
      await s3.storage.headObject(upload.objectKey),
    ]).toEqual(['initiated', 0, { sizeBytes: 6 * MiB }]);

    const retry = await outcomeOf(complete());
    expect([retry, await meetingCount()]).toEqual(['OK', 1]);
  });

  /**
   * AWS S3 có thể trả `NoSuchUpload` khi complete lại upload đã ghép xong ("might have been …
   * completed"). RustFS thì không → mô phỏng hành vi AWS bằng spy, để test đi qua đúng nhánh HEAD.
   * Đột biến: bỏ đường gỡ bằng HEAD → lần gọi lại nhận UPLOAD_NOT_ACTIVE, upload kẹt mãi.
   */
  it('server kiểu AWS báo NoSuchUpload khi complete lại → HEAD thấy object đúng kích thước → vẫn tạo meeting', async () => {
    const { complete, meetingCount } = await readyUpload(6 * MiB);
    vi.spyOn(repo, 'markCompleted').mockRejectedValueOnce(new Error('DB lỗi sau khi S3 đã ghép'));
    await expect(complete()).rejects.toThrow('DB lỗi sau khi S3 đã ghép');

    vi.spyOn(s3.storage, 'completeMultipartUpload').mockRejectedValueOnce(
      new MultipartUploadNotFoundError(),
    );
    const retry = await outcomeOf(complete());
    expect([retry, await meetingCount()]).toEqual(['OK', 1]);
  });

  it('multipart không còn và KHÔNG có object (đã bị huỷ thật) → 409 UPLOAD_NOT_ACTIVE, không tạo meeting', async () => {
    const { complete, meetingCount } = await readyUpload(6 * MiB);
    vi.spyOn(s3.storage, 'completeMultipartUpload').mockRejectedValueOnce(
      new MultipartUploadNotFoundError(),
    );
    expect([await outcomeOf(complete()), await meetingCount()]).toEqual(['UPLOAD_NOT_ACTIVE', 0]);
  });

  // Đột biến: `lockOwned` → đọc không khoá → hai transaction cùng tạo meeting.
  it('2 complete SONG SONG → đúng 1 meeting, cả hai trả về cùng meeting đó', async () => {
    const { complete, meetingCount } = await readyUpload(6 * MiB);

    const results = await Promise.all([complete(), complete()]);

    expect(results.map((r) => (r.created ? 'tạo mới' : 'trả lại')).sort()).toEqual([
      'trả lại',
      'tạo mới',
    ]);
    expect(results[0]?.meeting.id).toBe(results[1]?.meeting.id);
    expect(await meetingCount()).toBe(1);
  });

  it('Redis lỗi lúc enqueue → complete vẫn thành công; gọi lại complete enqueue lại (tự sửa)', async () => {
    const { complete } = await readyUpload(6 * MiB);
    queue.add.mockRejectedValueOnce(new Error('Redis sập'));
    enqueued.length = 0;

    const first = await complete();
    const again = await complete();

    expect([first.created, again.created, again.meeting.id]).toEqual([
      true,
      false,
      first.meeting.id,
    ]);
    expect(enqueued.map((e) => e.jobId)).toEqual([`meeting.preprocess.${first.meeting.id}.a1`]);
  });
});
