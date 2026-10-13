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
process.env.LOG_LEVEL = 'silent';

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../app.module.js');
const { configureApp } = await import('../bootstrap/configure-app.js');
const { buildOpenApiDocument } = await import('../bootstrap/swagger.js');

const app = await NestFactory.create(AppModule, { logger: false });
configureApp(app);
const document = buildOpenApiDocument(app);
await app.close();

const outFile = resolve(process.cwd(), 'openapi.json');
await writeFile(outFile, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Đã ghi ${outFile} (${Object.keys(document.paths).length} path)`);
