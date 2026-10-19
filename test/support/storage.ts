import { S3Client } from '@aws-sdk/client-s3';
import { inject } from 'vitest';
import { S3ObjectStorage } from '../../src/infra/storage/s3-object-storage.js';

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
