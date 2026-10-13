import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

process.title = 'meetnote-worker';

/**
 * Tiến trình worker: Nest application context (DI, lifecycle hooks) nhưng KHÔNG có HTTP server.
 * Chạy: `pnpm start:worker` (dev) hoặc `node dist/worker.js`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  // SIGTERM → đóng worker BullMQ (chờ job đang chạy), rồi đóng DB/Redis.
  app.enableShutdownHooks();

  logger.log('Worker đã sẵn sàng', 'WorkerBootstrap');
}

await bootstrap();
