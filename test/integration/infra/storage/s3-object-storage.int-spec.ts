import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MultipartUploadNotFoundError,
  ObjectNotFoundError,
} from '../../../../src/infra/storage/storage.errors.js';
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

  it('abort hai lần không lỗi (idempotent); upload phần sau khi abort → MultipartUploadNotFoundError', async () => {
    const key = newKey();
    const { uploadId } = await storage.createMultipartUpload(key, 'audio/mp4');

    await storage.abortMultipartUpload(key, uploadId);
    await expect(storage.abortMultipartUpload(key, uploadId)).resolves.toBeUndefined();
    // Adapter đổi `NoSuchUpload` của SDK thành lỗi của tầng storage — domain không biết tên lỗi SDK.
    await expect(
      storage.uploadPart({
        key,
        uploadId,
        partNumber: 1,
        body: byteStream(MiB),
        contentLength: MiB,
      }),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
  });

  it('headObject của key không tồn tại → undefined', async () => {
    expect(await storage.headObject(newKey())).toBeUndefined();
  });
});

describe('S3ObjectStorage: tải / đẩy FILE bằng stream (M6 B2)', () => {
  const { storage, close } = createTestStorage();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'meetnote-s3-file-'));
  });

  afterAll(async () => {
    close();
    await rm(dir, { recursive: true, force: true });
  });

  // Đột biến: bỏ `hash.update` trong khâu băm → sha256 sai (đỏ).
  it('đẩy rồi tải lại 24 MiB: nội dung, kích thước, sha256 (tính TRONG lúc tải) khớp file gốc', async () => {
    const source = join(dir, 'nguon.bin');
    const content = randomBytes(24 * 1024 * 1024);
    await writeFile(source, content);
    const key = `test/m6/${randomUUID()}.bin`;

    await storage.uploadFile(key, source, 'application/octet-stream');
    const downloaded = await storage.downloadToFile(key, join(dir, 'tai-ve.bin'));

    expect(downloaded).toEqual({
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect((await readFile(join(dir, 'tai-ve.bin'))).equals(content)).toBe(true);
  });

  it('object không có → ObjectNotFoundError (không phải lỗi SDK trần)', async () => {
    const error = await storage
      .downloadToFile(`test/m6/khong-co-${randomUUID()}`, join(dir, 'x.bin'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ObjectNotFoundError);
  });

  it('huỷ giữa chừng (AbortSignal) → reject, không treo', async () => {
    const source = join(dir, 'lon.bin');
    await writeFile(source, randomBytes(8 * 1024 * 1024));
    const key = `test/m6/${randomUUID()}.bin`;
    await storage.uploadFile(key, source, 'application/octet-stream');
    const controller = new AbortController();
    controller.abort(new Error('worker đang tắt'));
    await expect(
      storage.downloadToFile(key, join(dir, 'huy.bin'), controller.signal),
    ).rejects.toThrow('Request aborted'); // thông điệp của AWS SDK khi abortSignal kích hoạt
  });
});
