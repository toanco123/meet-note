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

afterAll(async () => {
  await database.drop();
});
