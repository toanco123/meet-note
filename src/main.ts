import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap/configure-app.js';
import { buildOpenApiDocument, setupSwagger } from './bootstrap/swagger.js';
import { type EnvironmentVariables, isSwaggerEnabled } from './config/env.validation.js';

process.title = 'meetnote-api';

async function bootstrap(): Promise<void> {
  // bufferLogs: giữ log trong lúc khởi động cho tới khi pino logger sẵn sàng.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  configureApp(app);
  // SIGTERM/SIGINT → gọi onApplicationShutdown của các module (đóng pool DB, Redis).
  // Đặt ở đây chứ không trong configureApp: test tạo nhiều app, không cần gắn signal handler.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);
  if (isSwaggerEnabled(config.get('NODE_ENV', { infer: true }))) {
    setupSwagger(app, buildOpenApiDocument(app));
  }

  await app.listen(config.get('PORT', { infer: true }));
}

await bootstrap();
