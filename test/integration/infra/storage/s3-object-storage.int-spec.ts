import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestStorage } from '../../../support/storage.js';

const MiB = 1024 * 1024;

/**
 * Stream sinh dữ liệu dần dần, KHÔNG tạo sẵn một Buffer cả phần — đúng hình dạng request upload
 * thật: adapter phải đẩy được stream lên S3 khi chỉ biết `contentLength`.
 */
function byteStream(size: number, fill = 0x61): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= size) {
        this.push(null);
        return;
      }
      const n = Math.min(64 * 1024, size - sent);
      sent += n;
      this.push(Buffer.alloc(n, fill));
    },
  });
}

async function s3ErrorName(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof S3ServiceException) return error.name;
    throw error;
  }
  throw new Error('Kỳ vọng S3 từ chối nhưng lệnh chạy thành công');
}

describe('S3ObjectStorage với RustFS thật', () => {
  const { storage, close } = createTestStorage();
  const newKey = () => `test/${randomUUID()}/source`;

  afterAll(() => {
    close();
  });

  it('multipart 2 phần (5 MiB + 1 MiB) bằng stream → complete → object đúng 6 MiB', async () => {
    const key = newKey();
    const { uploadId } = await storage.createMultipartUpload(key, 'audio/mp4');

    const p1 = await storage.uploadPart({
      key,
      uploadId,
      partNumber: 1,
      body: byteStream(5 * MiB),
      contentLength: 5 * MiB,
    });
    const p2 = await storage.uploadPart({
      key,
      uploadId,
      partNumber: 2,
      body: byteStream(MiB),
      contentLength: MiB,
    });
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: p2.etag }, // thứ tự lộn xộn: adapter tự sắp theo partNumber
      { partNumber: 1, etag: p1.etag },
    ]);

    expect(await storage.headObject(key)).toEqual({ sizeBytes: 6 * MiB });
  });

  it('gửi lại cùng một phần → dùng bản sau (PUT part idempotent ở phía S3)', async () => {
    const key = newKey();
    const { uploadId } = await storage.createMultipartUpload(key, 'audio/mp4');
    await storage.uploadPart({
      key,
      uploadId,
      partNumber: 1,
      body: byteStream(MiB, 0x61),
      contentLength: MiB,
    });
    const again = await storage.uploadPart({
      key,
      uploadId,
      partNumber: 1,
      body: byteStream(2 * MiB, 0x62),
      contentLength: 2 * MiB,
    });

    await storage.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag: again.etag }]);
    expect(await storage.headObject(key)).toEqual({ sizeBytes: 2 * MiB });
  });

  it('phần KHÔNG phải cuối nhỏ hơn 5 MiB → S3 từ chối lúc complete', async () => {
    const key = newKey();
    const { uploadId } = await storage.createMultipartUpload(key, 'audio/mp4');
    const p1 = await storage.uploadPart({
      key,
      uploadId,
      partNumber: 1,
      body: byteStream(MiB),
      contentLength: MiB,
    });
    const p2 = await storage.uploadPart({
      key,
      uploadId,
      partNumber: 2,
      body: byteStream(MiB),
      contentLength: MiB,
    });

    const name = await s3ErrorName(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: p1.etag },
        { partNumber: 2, etag: p2.etag },
      ]),
    );
    expect(name).toBe('EntityTooSmall');
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('abort hai lần không lỗi (idempotent); upload phần sau khi abort → NoSuchUpload', async () => {
    const key = newKey();
    const { uploadId } = await storage.createMultipartUpload(key, 'audio/mp4');

    await storage.abortMultipartUpload(key, uploadId);
    await expect(storage.abortMultipartUpload(key, uploadId)).resolves.toBeUndefined();
    const name = await s3ErrorName(
      storage.uploadPart({
        key,
        uploadId,
        partNumber: 1,
        body: byteStream(MiB),
        contentLength: MiB,
      }),
    );
    expect(name).toBe('NoSuchUpload');
  });

  it('headObject của key không tồn tại → undefined', async () => {
    expect(await storage.headObject(newKey())).toBeUndefined();
  });
});
