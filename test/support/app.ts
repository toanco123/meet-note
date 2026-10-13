import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { buildOpenApiDocument, setupSwagger } from '../../src/bootstrap/swagger.js';

export interface TestAppOptions {
  /** Controller chỉ có trong test (vd controller thăm dò để test guard độc lập với tính năng). */
  controllers?: Type<unknown>[];
}

/** Tạo app giống hệt main.ts (cùng configureApp), dùng DB/Redis do setup-e2e cấp. */
export async function createTestApp(options: TestAppOptions = {}): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({ logger: false });

  configureApp(app);
  setupSwagger(app, buildOpenApiDocument(app));

  await app.init();
  return app;
}
