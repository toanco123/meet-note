import type { INestApplication, INestApplicationContext, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap/configure-app.js';
import { buildOpenApiDocument, setupSwagger } from '../../src/bootstrap/swagger.js';
import { createPgPool, PG_POOL } from '../../src/infra/database/database.module.js';
import { SUMMARIZER } from '../../src/infra/llm/llm.module.js';
import type { Summarizer } from '../../src/infra/llm/llm.types.js';
import { SPEECH_TO_TEXT } from '../../src/infra/speech/speech.module.js';
import type { SpeechToText } from '../../src/infra/speech/speech.types.js';
import { WorkerModule } from '../../src/worker.module.js';
import { WORKER_SCHEDULES_ENABLED } from '../../src/worker/worker-schedules.js';

export interface TestAppOptions {
  /** Controller chỉ có trong test (vd controller thăm dò để test guard độc lập với tính năng). */
  controllers?: Type<unknown>[];
  /**
   * Chạy TRƯỚC `app.init()` — như main.ts gắn Swagger / trang thử trước `listen()`. Route Express
   * gắn SAU init nằm sau handler 404 của Nest → không bao giờ tới được (M7 bài học).
   */
  beforeInit?: (app: INestApplication<App>) => void;
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
  options.beforeInit?.(app);

  await app.init();
  return app;
}

/**
 * Tiến trình worker trong test (như worker.ts: application context, không HTTP) — chạy processor
 * thật trên Redis thật, cùng DB / prefix queue của file test. Đóng bằng `close()` (chờ job đang chạy).
 */
export async function createTestWorker(
  overrides: { speech?: SpeechToText; summarizer?: Summarizer; schedules?: boolean } = {},
): Promise<INestApplicationContext> {
  // Như compose: worker kết nối bằng user RIÊNG (BYPASSRLS — job xuyên tổ chức, M11 B7).
  let builder = Test.createTestingModule({ imports: [WorkerModule] });
  // Bộ nhận dạng / tóm tắt giả có hành vi riêng (lỗi N lần, treo…) cho từng test (M6 B5).
  if (overrides.speech)
    builder = builder.overrideProvider(SPEECH_TO_TEXT).useValue(overrides.speech);
  if (overrides.summarizer)
    builder = builder.overrideProvider(SUMMARIZER).useValue(overrides.summarizer);
  // Lịch chạy tắt trong test (setup-e2e); test lịch bật riêng cho worker của mình (M6 B8).
  if (overrides.schedules !== undefined)
    builder = builder.overrideProvider(WORKER_SCHEDULES_ENABLED).useValue(overrides.schedules);
  const moduleRef = await builder
    .overrideProvider(PG_POOL)
    .useFactory({
      factory: () =>
        createPgPool({
          connectionString: process.env.TEST_WORKER_DATABASE_URL!,
          max: 5,
          applicationName: 'meetnote-worker-test',
          lockTimeoutMs: 3_000,
          statementTimeoutMs: 60_000,
          idleInTransactionTimeoutMs: 30_000,
        }),
    })
    .compile();
  moduleRef.useLogger(false);
  return moduleRef.init();
}
