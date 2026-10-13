---
name: testing
description: Viết, chạy và sửa test cho MeetNote bằng Vitest 5 — unit test (hàm thuần, policy, Nest TestingModule), integration/e2e với Postgres 18 và Redis thật qua Testcontainers (mỗi file test một database clone từ template), test concurrency, test ma trận quyền dạng bảng, Fake cho provider ngoài, giả lập thời gian. Dùng khi người dùng muốn thêm test, test đang đỏ, hỏi cách test một tính năng, chạy pnpm test hoặc pnpm test:e2e, hoặc ngay sau khi viết code mới cần kiểm chứng. Use for any test authoring or test failure in this repo.
---

# Test trong MeetNote

Chiến lược tổng thể nằm ở `docs/design/08-testing.md`. Skill này là phần "làm thế nào".

## Ba tầng

| Tầng        | File                           | Lệnh            | Cần Docker |
| ----------- | ------------------------------ | --------------- | ---------- |
| Unit        | `src/**/*.spec.ts` (cạnh code) | `pnpm test`     | Không      |
| Integration | `src/**/*.int-spec.ts`         | `pnpm test:e2e` | Có         |
| E2E         | `test/e2e/*.e2e-spec.ts`       | `pnpm test:e2e` | Có         |

Chạy một file / một test:

- `pnpm vitest run src/common/pagination/cursor.spec.ts -t "round-trip"`
- `pnpm test:e2e test/e2e/health.e2e-spec.ts`

## Hạ tầng có sẵn (đừng viết lại)

- `test/support/global-setup.ts`: khởi động Postgres 18 + Redis 8 **một lần**, migrate vào database template `meetnote_template`.
- `test/support/setup-e2e.ts`: **trước mỗi file test**, clone một database riêng từ template (`CREATE DATABASE … TEMPLATE`), rồi đặt `process.env.DATABASE_URL`/`REDIS_URL`/`NODE_ENV=test`/`LOG_LEVEL=silent`. File test xong thì `DROP … WITH (FORCE)`.
- `test/support/app.ts`: `createTestApp()` tạo app giống `main.ts` (cùng `configureApp` + Swagger), dùng DB của file đó.
- `test/support/database.ts`: `createTestDatabase`, `withDatabase`, và hằng image Postgres/Redis.
- Vitest config đã nạp `reflect-metadata` trong `setupFiles`.

## Mẫu e2e

```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/app.js';

describe('Channels (e2e)', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('cursor hỏng → 400 INVALID_CURSOR', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/orgs/${orgId}/channels?cursor=xxx`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});
```

Truy vấn DB trực tiếp trong test: `app.get(DRIZZLE)` để dùng Drizzle, hoặc `new Client({ connectionString: process.env.DATABASE_URL })`.

## Quy tắc

1. **Không mock DB** ở integration/e2e. Mục tiêu là kiểm tra SQL, constraint và lock thật.
2. **Import tường minh** từ `vitest` (`describe`, `it`, `expect`, `vi`). Dự án không bật globals.
3. **Dữ liệu:** factory trong `test/support/factories.ts` (tạo từ M1), ví dụ `createUser()`, `createOrg({ owner })`. Mỗi file có DB riêng nên không cần dọn giữa các file. Trong một file thì dùng dữ liệu duy nhất (email ngẫu nhiên), để thứ tự test không ảnh hưởng nhau.
4. **Ma trận quyền** viết thành bảng `it.each`, xem skill `authorization`.
5. **Concurrency:** `Promise.allSettled` với 2 connection, xem skill `db-transactions`. Kiểm chứng: bỏ lock thì test phải đỏ.
6. **Thời gian:** inject `Clock`, test dùng giờ cố định. Kiểm tra ca biên múi giờ VN, ví dụ 00:30 thứ 2 giờ VN = 17:30 chủ nhật UTC.
7. **Provider ngoài** (Whisper, LLM, S3 khi cần) dùng Fake cài qua interface, có thể cấu hình "lỗi N lần đầu".
8. **Mock:** `vi.fn<(arg: T) => R>()` có tham số kiểu, vì oxlint bật `vitest/require-mock-type-parameters`. Không đặt `expect` trong `if`/`catch`. Để kiểm tra lỗi ném ra, dùng `expect(fn).toThrow(expect.objectContaining({ code: '...' }))`.
9. Không có Docker thì **nói rõ e2e chưa chạy**. Không báo pass khi chưa thấy kết quả.

## Bẫy

- **`ConfigModule.forRoot()` validate env ngay lúc import `AppModule`.** Env phải được đặt trong `setupFiles`. Đặt trong `beforeAll` là đã muộn.
- **Vitest không chạy Swagger CLI plugin.** Test kiểm tra schema DTO chi tiết thì chạy trên `dist/` (`pnpm build && pnpm openapi:export`).
- **Clone template song song có thể lỗi `55006`.** `createDatabase` đã retry. Lỗi vẫn còn thì kiểm tra xem còn connection nào trỏ vào template không.
- Pool trong app test mặc định `DATABASE_POOL_MAX=10`. Test concurrency chạy nhiều luồng hơn thì tăng giá trị này.
- `app.close()` gọi `onApplicationShutdown` để đóng pool/Redis. Quên gọi thì Vitest treo cuối lượt chạy.
