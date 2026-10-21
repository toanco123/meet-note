import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REALTIME_TEST_PAGE_PATH,
  setupRealtimeTestPage,
} from '../../../src/bootstrap/realtime-test-page.js';
import { createTestApp } from '../../support/app.js';

/** Trang thử Socket.IO (M7 B6): chỉ bật khi main.ts gọi `setupRealtimeTestPage` (NODE_ENV=development). */
describe('Realtime: trang thử /realtime-test.html (e2e)', () => {
  let plain: INestApplication<App>;
  let dev: INestApplication<App>;

  beforeAll(async () => {
    plain = await createTestApp();
    dev = await createTestApp({ beforeInit: setupRealtimeTestPage });
  });

  afterAll(async () => {
    await plain.close();
    await dev.close();
  });

  it('không bật → 404 (không lộ công cụ dev ngoài môi trường dev)', async () => {
    await request(plain.getHttpServer()).get(REALTIME_TEST_PAGE_PATH).expect(404);
  });

  it('bật → HTML dùng client Socket.IO do chính server phát (/socket.io/socket.io.js)', async () => {
    const page = await request(dev.getHttpServer()).get(REALTIME_TEST_PAGE_PATH).expect(200);
    await dev.listen(0);
    const client = await request(dev.getHttpServer()).get('/socket.io/socket.io.js').expect(200);

    expect([
      page.headers['content-type'],
      page.text.includes('<script src="/socket.io/socket.io.js"></script>'),
      page.text.includes("io('/realtime'"),
      client.text.length > 1000,
    ]).toEqual(['text/html; charset=utf-8', true, true, true]);
  });
});
