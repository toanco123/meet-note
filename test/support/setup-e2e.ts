import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { createTestDatabase } from './database.js';
import { closeFixtureDb } from './db.js';

/**
 * Chạy TRƯỚC mỗi file test (trước cả khi file test import AppModule).
 *
 * Phải đặt process.env ở đây: `ConfigModule.forRoot()` đọc và validate env ngay lúc
 * AppModule được import (decorator chạy lúc import), đặt trong beforeAll là đã muộn.
 */
const database = await createTestDatabase(inject('postgresAdminUrl'));

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
// App (và test dựng pool từ DATABASE_URL) chạy bằng user api, KHÔNG superuser (M11 B6) — lỡ thiếu
// GRANT thì e2e đỏ ngay. Test cần quyền chủ dùng TEST_ADMIN_DATABASE_URL.
process.env.DATABASE_URL = database.appUrl;
process.env.TEST_ADMIN_DATABASE_URL = database.url;
process.env.TEST_WORKER_DATABASE_URL = database.workerUrl;
process.env.REDIS_URL = inject('redisUrl');
process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
const s3 = inject('s3');
process.env.S3_ENDPOINT = s3.endpoint;
process.env.S3_BUCKET = s3.bucket;
process.env.S3_ACCESS_KEY_ID = s3.accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = s3.secretAccessKey;
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.REALTIME_CORS_ORIGINS = 'http://app.meetnote.test';
// Redis dùng chung giữa các file test chạy song song → mỗi file một kênh Socket.IO riêng (như DB riêng).
process.env.REALTIME_REDIS_KEY = `meetnote-test:${randomBytes(6).toString('hex')}:socket.io`;
// Cùng lý do cho BullMQ: worker của file này không được lấy job của file khác (DB khác).
process.env.QUEUE_PREFIX = `meetnote-test-${randomBytes(6).toString('hex')}`;
// Mỗi file đăng ký hàng loạt user từ 127.0.0.1 → tắt rate limit; file test rate limit tự bật lại
// (`vi.hoisted`). Prefix riêng như trên.
process.env.RATE_LIMIT_ENABLED = 'false';
// CI không có model whisper: worker trong test dùng bộ nhận dạng giả (test có thể thay bằng bản khác).
process.env.SPEECH_PROVIDER = 'fake';
// Lịch chạy của worker (M6 B8) tắt: dọn dẹp / quét kẹt chạy lên DB của test đang dựng fixture. Test
// lịch bật lại qua `createTestWorker({ schedules: true })`.
process.env.WORKER_SCHEDULES_ENABLED = 'false';
process.env.RATE_LIMIT_PREFIX = `meetnote-test-${randomBytes(6).toString('hex')}:rate-limit`;

afterAll(async () => {
  await closeFixtureDb();
  await database.drop();
});
