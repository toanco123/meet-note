import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Xuất `openapi.json` ra thư mục gốc để sinh client frontend và để CI phát hiện thay đổi API.
 * Chạy: `pnpm build && pnpm openapi:export`.
 *
 * Phải chạy từ bản build (`dist/`): Swagger CLI plugin chỉ chạy lúc `nest build`, chạy từ
 * nguồn sẽ thiếu schema của DTO.
 *
 * Không cần Postgres/Redis thật: pool `pg` và ioredis (lazyConnect) chỉ kết nối khi có truy vấn.
 * Nhưng ConfigModule vẫn validate env lúc import AppModule → đặt giá trị giả TRƯỚC khi import.
 */
process.env.DATABASE_URL ??= 'postgres://openapi:openapi@127.0.0.1:5432/openapi';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_ACCESS_SECRET ??= 'openapi-export-dummy-secret-not-used-0000';
// M5: S3 bắt buộc. Không kết nối thật: `S3_CREATE_BUCKET` mặc định false, client chỉ gọi khi dùng.
process.env.S3_BUCKET ??= 'openapi';
process.env.S3_ACCESS_KEY_ID ??= 'openapi';
process.env.S3_SECRET_ACCESS_KEY ??= 'openapi-export-dummy';
process.env.LOG_LEVEL = 'silent';

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../app.module.js');
const { configureApp } = await import('../bootstrap/configure-app.js');
const { buildOpenApiDocument } = await import('../bootstrap/swagger.js');

// BẪY (M5): `logger: false` tắt cả log lỗi khởi tạo, và mặc định Nest tự `process.exit(1)` khi
// khởi tạo lỗi → script chết IM LẶNG (CI chỉ thấy exit 1). `abortOnError: false` → lỗi ném ra, Node in ra.
const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
configureApp(app);
const document = buildOpenApiDocument(app);
await app.close();

const outFile = resolve(process.cwd(), 'openapi.json');
await writeFile(outFile, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Đã ghi ${outFile} (${Object.keys(document.paths).length} path)`);
