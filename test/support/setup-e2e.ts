import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { createTestDatabase } from './database.js';

/**
 * Chạy TRƯỚC mỗi file test (trước cả khi file test import AppModule).
 *
 * Phải đặt process.env ở đây: `ConfigModule.forRoot()` đọc và validate env ngay lúc
 * AppModule được import (decorator chạy lúc import), đặt trong beforeAll là đã muộn.
 */
const database = await createTestDatabase(inject('postgresAdminUrl'));

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = database.url;
process.env.REDIS_URL = inject('redisUrl');
process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
const s3 = inject('s3');
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = s3.bucket;
process.env.S3_ACCESS_KEY_ID = s3.accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = s3.secretAccessKey;
process.env.S3_FORCE_PATH_STYLE = 'true';

afterAll(async () => {
  await database.drop();
});
