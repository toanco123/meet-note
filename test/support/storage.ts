import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { inject } from 'vitest';
import { S3ObjectStorage } from '../../src/infra/storage/s3-object-storage.js';
import { MultipartUploadNotFoundError } from '../../src/infra/storage/storage.errors.js';
import type { ObjectStorage } from '../../src/infra/storage/storage.types.js';

/** Adapter S3 trỏ vào RustFS của lượt test (cho integration test không dựng cả app). */
export function createTestStorage(): {
  storage: S3ObjectStorage;
  client: S3Client;
  close: () => void;
} {
  const s3 = inject('s3');
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
  });
  return { storage: new S3ObjectStorage(client, s3.bucket), client, close: () => client.destroy() };
}

/**
 * Multipart còn sống trên S3 không — gửi thử một phần nhỏ (phần số 10000 để không đè phần thật).
 * Dùng để chứng minh "đã abort thật trên S3", không chỉ "DB ghi là aborted".
 */
export async function isMultipartAlive(
  storage: ObjectStorage,
  key: string,
  uploadId: string,
): Promise<boolean> {
  try {
    await storage.uploadPart({
      key,
      uploadId,
      partNumber: 10_000,
      body: Readable.from([Buffer.alloc(16)]),
      contentLength: 16,
    });
    return true;
  } catch (error) {
    if (error instanceof MultipartUploadNotFoundError) return false;
    throw error;
  }
}
