import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE } from '../../../../src/infra/database/database.module.js';
import { QueueName } from '../../../../src/infra/queue/queue.module.js';
import { OBJECT_STORAGE } from '../../../../src/infra/storage/storage.module.js';
import { MeetingsRepository } from '../../../../src/modules/meetings/repositories/meetings.repository.js';
import { MeetingsService } from '../../../../src/modules/meetings/services/meetings.service.js';
import { ChannelsRepository } from '../../../../src/modules/channels/repositories/channels.repository.js';
import { UploadsRepository } from '../../../../src/modules/uploads/uploads.repository.js';
import { UploadsCleanupService } from '../../../../src/modules/uploads/services/uploads-cleanup.service.js';
import { UploadsService } from '../../../../src/modules/uploads/services/uploads.service.js';
import { realtimeStub } from '../../../support/realtime-stub.js';
import { createTestDb, type TestDb } from '../../../support/db.js';
import { createTestStorage, isMultipartAlive } from '../../../support/storage.js';

/**
 * Hành động BÙ TRỪ của init: multipart mở trên S3 xong mà INSERT lỗi → phải abort ngay. Không abort
 * thì multipart không có dòng DB nào trỏ tới → job dọn dẹp không bao giờ thấy → phần mồ côi mãi trên S3.
 * Đột biến bỏ khối `catch` bù trừ → multipart còn sống → test đỏ.
 */
describe('UploadsService.init — bù trừ khi ghi DB lỗi (Postgres + RustFS thật)', () => {
  let t: TestDb;
  const s3 = createTestStorage();
  let service: UploadsService;
  let repo: UploadsRepository;

  beforeAll(async () => {
    t = createTestDb();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UploadsService,
        UploadsCleanupService,
        UploadsRepository,
        MeetingsRepository,
        MeetingsService,
        ChannelsRepository,
        {
          provide: getQueueToken(QueueName.Default),
          useValue: { add: vi.fn<() => Promise<void>>() },
        },
        { provide: DRIZZLE, useValue: t.db },
        realtimeStub,
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

  it('INSERT lỗi → lỗi gốc lọt ra cho client, multipart vừa mở đã bị abort', async () => {
    const opened = vi.spyOn(s3.storage, 'createMultipartUpload');
    vi.spyOn(repo, 'insert').mockRejectedValueOnce(new Error('DB sập giữa chừng'));

    await expect(
      service.init('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', {
        filename: 'a.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        title: 'Họp',
        recordedAt: '2026-10-19T02:00:00.000Z',
      }),
    ).rejects.toThrow('DB sập giữa chừng');

    const call = opened.mock.calls[0];
    const result = opened.mock.results[0];
    if (!call || !result) throw new Error('createMultipartUpload chưa được gọi');
    const [key] = call;
    const { uploadId } = await (result.value as Promise<{ uploadId: string }>);
    expect(await isMultipartAlive(s3.storage, key, uploadId)).toBe(false);
  });
});
