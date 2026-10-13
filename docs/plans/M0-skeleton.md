# M0 — Dựng khung dự án

- **Trạng thái:** Xong (2026-10-13). CI xanh toàn bộ. E2E và Docker Compose đã chạy trên máy dev (OrbStack)
- **Tài liệu thiết kế liên quan:** [02-architecture](../design/02-architecture.md), [07-conventions](../design/07-conventions.md), [08-testing](../design/08-testing.md), [09-versions](../design/09-versions.md)

## Mục tiêu

Có một bộ khung chạy được, trên đó các mốc sau chỉ cần thêm module nghiệp vụ:

- api khởi động, `GET /health/live` và `/health/ready` (kiểm tra DB + Redis)
- `/docs` (Swagger UI, giữ token khi reload), `/docs-json`
- worker khởi động như một tiến trình riêng, kết nối Redis
- Migration đầu tiên tạo extension + `f_unaccent` + text search config `meetnote_vi`
- Lỗi trả đúng định dạng chung, mỗi request có `x-request-id`
- Unit test + e2e test (Testcontainers) + lint chạy được, CI chạy được

## Ngoài phạm vi

- Mọi bảng nghiệp vụ (bắt đầu từ M1)
- Auth: chưa có guard. Swagger đã cấu hình sẵn Bearer để M1 dùng

## Các bước

- [x] B1 — Khởi tạo project
  - `package.json` (ESM, `packageManager: pnpm@12`, `engines.node >=24`), `tsconfig*.json` (strict), `nest-cli.json` (Swagger plugin), `.oxlintrc.json`, `.prettierrc`, `.gitignore`, `.editorconfig`, `.nvmrc`
- [x] B2 — Config
  - `src/config/env.validation.ts`: class `EnvironmentVariables` + `validateEnv()`. Sai thì dừng khi khởi động
  - Test: unit test cho `validateEnv` (thiếu `DATABASE_URL` → throw, giá trị mặc định đúng)
- [x] B3 — Logging
  - nestjs-pino, `genReqId` lấy `x-request-id` hợp lệ hoặc sinh UUID, trả header, redact
- [x] B4 — Lỗi & response chung
  - `AppException`, `ErrorCode`, `AllExceptionsFilter` (map HttpException, lỗi validate, lỗi Postgres 23505/23503)
  - `ErrorResponseDto`, `@ApiErrorResponses()`
  - Test: unit test filter map đúng status/code
- [x] B5 — Phân trang cursor dùng chung
  - `encodeCursor` / `decodeCursor`, `CursorQueryDto`, `@ApiPaginatedResponse()`
  - Test: unit test round-trip + cursor hỏng → `INVALID_CURSOR`
- [x] B6 — Bootstrap dùng chung
  - `configureApp()`: versioning URI v1, ValidationPipe, filter. Dùng chung cho `main.ts` và e2e. `enableShutdownHooks` đặt riêng trong `main.ts`/`worker.ts`
  - `setupSwagger()`: chỉ bật khi không phải production. Bearer + `persistAuthorization`. Tag theo module
- [x] B7 — Database
  - `DatabaseModule` (global): pool `pg`, Drizzle (`casing: snake_case`), token `DRIZZLE`, đóng pool khi shutdown
  - `drizzle.config.ts`, `migrations/0000_extensions.sql` (viết tay), script `migrate.ts`
- [x] B8 — Redis & Queue
  - `RedisModule` (ioredis, đóng khi shutdown), `QueueModule` (BullMQ root config, tên queue)
- [x] B9 — Health
  - `/health/live`, `/health/ready` (`SELECT 1`, `PING`), `VERSION_NEUTRAL`
- [x] B10 — Worker entry
  - `worker.ts` + `WorkerModule` (application context, không HTTP, `enableShutdownHooks`)
  - `WorkerHeartbeatService`: ghi `meetnote:workers:<host>:<pid>` (TTL 45s) mỗi 15s, đồng thời giữ event loop
- [x] B11 — Test harness
  - `vitest.config.ts` (unit), `vitest.config.e2e.ts` (globalSetup Testcontainers: Postgres + Redis, migrate vào template DB)
  - `test/e2e/health.e2e-spec.ts`, `test/e2e/platform.e2e-spec.ts` (định dạng lỗi, Swagger, migration `f_unaccent`/`meetnote_vi`/`uuidv7`)
- [x] B12 — Script OpenAPI
  - `src/scripts/export-openapi.ts` → `openapi.json`
- [x] B13 — Docker & Compose
  - `docker/Dockerfile` multi-stage (deps → build → runtime, user non-root)
  - `compose.yaml`: postgres, redis, rustfs, migrate (one-shot), api, worker. Có healthcheck và `depends_on: condition`
- [x] B14 — CI
  - `.github/workflows/ci.yml`: lint → unit → e2e → build + openapi diff → docker build

## Tiêu chí hoàn thành

- [x] `pnpm format:check`, `pnpm lint`, `pnpm typecheck` xanh
- [x] `pnpm test` xanh (28 test)
- [x] `pnpm build` thành công, `pnpm openapi:export` sinh `openapi.json`
- [x] Smoke test không cần Docker: api lên, `/health/live` 200, `/health/ready` 503 khi DB/Redis chết, 404 đúng định dạng lỗi, `/docs` 200 ở dev và 404 ở production, env sai thì dừng với thông báo rõ, worker sống và tắt ngay khi nhận SIGTERM
- [x] `pnpm test:e2e` xanh: trên CI (GitHub Actions run 38368476184; lần đầu 9/10, 1 test sai kỳ vọng đã sửa, xem bài học 13) và trên máy dev (11/11, 34s)
- [x] `docker compose up --build`: migrate thoát 0, api healthy, `/health/ready` 200 (database + redis `up`), worker ghi heartbeat vào Redis, RustFS phản hồi ở :9000. `docker compose stop` thì api/worker thoát 0 và heartbeat tự xoá

## Điều học được / bẫy gặp phải

Ghi lại trong lúc dựng khung (2026-10-13):

1. **TypeScript 7 chưa dùng được với Nest.** TS 7.0.2 là `latest` trên npm, nhưng `@nestjs/swagger` chỉ khai báo peer `^5.5 || ^6`. Swagger CLI plugin dùng transformer API của compiler TS. Giải pháp: pin `~6.0.3`.
2. **pnpm 12 chặn build script của dependency** (`ERR_PNPM_IGNORED_BUILDS`). Phải khai báo `allowBuilds` trong `pnpm-workspace.yaml`. Chỉ cho phép `esbuild`, `msgpackr-extract`. Từ chối `@scarf/scarf` (telemetry), `ssh2`, `cpu-features` (native addon tuỳ chọn), `protobufjs`. pnpm 12 còn có `minimumReleaseAge`: package phát hành quá mới bị từ chối, phải ghi ngoại lệ vào `minimumReleaseAgeExclude`. Đây là hai lớp phòng thủ supply-chain.
3. **MinIO không còn image trên Docker Hub.** Đổi sang RustFS. Code chỉ phụ thuộc S3 API nên đổi nhà cung cấp không ảnh hưởng.
4. **Vitest + `reflect-metadata`.** File test không import `@nestjs/*` sẽ lỗi `Reflect.getMetadata is not a function` khi gặp `@Type()` của class-transformer. Nạp `reflect-metadata` trong `setupFiles`.
5. **Vitest 5 (Oxc) phát decorator metadata đúng.** Không cần `unplugin-swc`. Test `HealthController` inject theo kiểu constructor là bằng chứng.
6. **Swagger plugin chạy được với build ESM.** Schema sinh từ kiểu TS + JSDoc. Kiểu trả về của method thành response. Câu đầu của JSDoc thành `summary`, còn `@remarks` thành `description`. Vitest **không** chạy plugin, nên test schema phải dùng `dist/`.
7. **Worker tự thoát với exit 0.** `createApplicationContext` không giữ event loop. Pool `pg` và ioredis (`lazyConnect`) chưa mở socket, và chưa có BullMQ Worker nào. Heartbeat (`setInterval`) giữ tiến trình sống. Từ M6, BullMQ Worker cũng sẽ giữ.
8. **Shutdown treo 10s khi Redis chết.** `quit()`/`del()` chờ vòng retry. Chỉ QUIT êm khi `status === 'ready'`, còn lại thì `disconnect()` ngay. Exit code 143 sau SIGTERM là bình thường, vì Nest gửi lại signal cho chính nó sau khi chạy xong hook.
9. **`enableShutdownHooks` không nên nằm trong hàm cấu hình dùng chung.** Test tạo nhiều app thì mỗi app lại gắn thêm signal listener. `app.close()` vẫn gọi đủ các hook.
10. **Drizzle ≥ 0.44 bọc lỗi `pg` trong `cause`.** Filter phải đi dọc chuỗi `cause` mới nhận ra mã `23505`.
11. **Postgres 18 image đổi PGDATA** thành `/var/lib/postgresql/18/docker`. Volume phải mount `/var/lib/postgresql`.
12. **`ConfigModule.forRoot()` validate env lúc import AppModule.** Vì vậy e2e phải đặt `process.env` trong `setupFiles`, còn script export OpenAPI phải đặt env giả trước khi `import()` động.
13. **`unaccent` không chỉ bỏ dấu.** `unaccent.rules` còn map ký tự Unicode sang ASCII: `—` thành `-`, `…` thành `...`. Có lợi cho search, nhưng không dùng `f_unaccent` để hiển thị lại văn bản. Phát hiện nhờ e2e chạy trên Postgres thật ở CI, unit test không thể bắt được.
14. **BullMQ cấm `:` trong custom jobId** (`Custom Id cannot contain :`). Ngoài ra jobId phải chứa tên bước và số lần chạy, nếu không job bị nuốt vì trùng ID. Đã sửa trong `03-database.md`, `06-flows.md`, `07-conventions.md`.
15. **Testcontainers không đọc docker context.** Nó chỉ tìm `DOCKER_HOST`, `~/.testcontainers.properties` và `/var/run/docker.sock`. OrbStack cài không có quyền admin thì không tạo `/var/run/docker.sock`, nên phải thêm `docker.host=unix://$HOME/.orbstack/run/docker.sock` vào `~/.testcontainers.properties`. Đây là cấu hình theo máy, không commit.
16. **OrbStack khởi động bằng `orbctl start` trước khi mở app thì bỏ qua bước cài CLI.** Không có `~/.orbstack/bin`, và `docker compose` báo `unknown command`. Phải link tool vào `~/.orbstack/bin`, thêm vào PATH (`~/.zprofile`), và link plugin vào `~/.docker/cli-plugins/`. Kiểm tra bằng `orbctl doctor`.

Mọi tiêu chí đã đạt. Mốc tiếp theo: M1 — Auth (viết plan trước khi code).
