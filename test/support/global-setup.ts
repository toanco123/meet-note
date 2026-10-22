import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/infra/database/migrate.js';
import { provisionLoginRoles } from '../../src/infra/database/provision-roles.js';
import {
  createDatabase,
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  RUSTFS_IMAGE,
  TEMPLATE_DATABASE,
  TEST_DB_PASSWORDS,
  withDatabase,
} from './database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL tới database mặc định của container — chỉ dùng để CREATE/DROP database. */
    postgresAdminUrl: string;
    redisUrl: string;
    /** RustFS (S3) dùng chung cho cả lượt test; bucket tạo sẵn, key đã chứa uuid nên không đụng nhau. */
    s3: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
  }
}

const S3_TEST = {
  bucket: 'meetnote-test',
  accessKeyId: 'meetnote-test',
  secretAccessKey: 'meetnote-test-secret',
};

/** RustFS mở cổng trước khi sẵn sàng nhận request → thử tạo bucket vài lần. */
async function createBucketWithRetry(endpoint: string): Promise<void> {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_TEST.accessKeyId, secretAccessKey: S3_TEST.secretAccessKey },
  });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: S3_TEST.bucket }));
        return;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } finally {
    client.destroy();
  }
}

/** Chạy MỘT lần cho cả lượt test: khởi động container, migrate vào database template. */
export default async function setup(project: TestProject) {
  const [postgres, redis, rustfs] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
    new GenericContainer(RUSTFS_IMAGE)
      .withEnvironment({
        RUSTFS_ACCESS_KEY: S3_TEST.accessKeyId,
        RUSTFS_SECRET_KEY: S3_TEST.secretAccessKey,
      })
      .withExposedPorts(9000)
      .start(),
  ]);
  const s3Endpoint = `http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`;
  await createBucketWithRetry(s3Endpoint);

  const adminUrl = postgres.getConnectionUri();
  await createDatabase(adminUrl, TEMPLATE_DATABASE);
  // runMigrations tự đóng pool sau khi xong — template phải KHÔNG còn kết nối nào
  // thì CREATE DATABASE ... TEMPLATE mới chạy được.
  await runMigrations(withDatabase(adminUrl, TEMPLATE_DATABASE));
  // Role thuộc CẢ cluster: tạo một lần, mọi database clone từ template đều dùng được (M11 B6).
  await provisionLoginRoles(adminUrl, TEST_DB_PASSWORDS);

  project.provide('postgresAdminUrl', adminUrl);
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('s3', { endpoint: s3Endpoint, ...S3_TEST });

  return async () => {
    await Promise.all([postgres.stop(), redis.stop(), rustfs.stop()]);
  };
}
