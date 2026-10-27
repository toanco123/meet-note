# 07 — Quy ước

## 1. Đặt tên

| Đối tượng               | Quy ước                                                                                  | Ví dụ                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| File                    | kebab-case + hậu tố vai trò                                                              | `channel-members.service.ts`, `create-channel.dto.ts`, `channel.policy.ts` |
| Class                   | PascalCase + hậu tố                                                                      | `ChannelMembersService`, `CreateChannelDto`, `ChannelResponseDto`          |
| DTO                     | `<Động từ><Danh từ>Dto` cho input, `<Danh từ>ResponseDto` cho output                     | `UpdateMemberRoleDto`, `MemberResponseDto`                                 |
| Bảng/cột DB             | snake_case, bảng số nhiều                                                                | `channel_members.joined_at`                                                |
| Path API                | kebab-case, danh từ số nhiều. Hành động không phải CRUD dùng `POST /resource/:id/<verb>` | `/ownership-transfer`, `/archive`                                          |
| JSON field              | camelCase                                                                                | `nextCursor`, `recordedAt`                                                 |
| Giá trị enum (DB + API) | lowercase snake                                                                          | `'owner'`, `'in_progress'`                                                 |
| Mã lỗi                  | UPPER_SNAKE, có tiền tố domain                                                           | `CHANNEL_ARCHIVED`, `INVITE_EXPIRED`                                       |
| Queue / job name        | `domain.action`                                                                          | queue `meetings`, job `meeting.transcribe`                                 |
| BullMQ jobId            | `<job-name>.<entityId>[.<lần>]`, **không có `:`** (BullMQ cấm)                           | `meeting.transcribe.0199d7a2-….a1`                                         |
| Audit action            | `domain.object.verb_past`                                                                | `org.member.role_changed`                                                  |
| Env                     | UPPER_SNAKE, có tiền tố nhóm                                                             | `DATABASE_URL`, `S3_BUCKET`                                                |

**Thư mục theo vai trò (từ M4 B4d):** trong một thư mục, khi có **từ 2 file cùng vai trò** trở lên (`*.service.ts`, `*.repository.ts`, `*.controller.ts`, `*.types.ts`) thì gom vào `services/`, `repositories/`, `controllers/`, `types/`. Chỉ có 1 file thì để ngay cấp module. `dto/` và `guards/` luôn là thư mục. `*.module.ts` luôn ở cấp module (cửa vào của thư mục). Thư mục vai trò chỉ chứa đúng vai trò đó. Test kiến trúc `test/unit/architecture/folder-layout.spec.ts` canh quy tắc này.

**Đặt interface / type ở đâu (từ M4 B4c):**

- Interface / type **viết tay, được export** nằm trong `<module>.types.ts` của module đó (`channels/channels.types.ts`, `auth/auth.types.ts`, `common/pagination/pagination.types.ts`…). Gồm cả khối `declare global` mở rộng `Express.Request`. Trong file chia nhóm theo lớp dùng (policy + guard → repository).
- Kiểu **suy ra từ một giá trị** để **cạnh giá trị gốc**: `(typeof X)[number]`, `typeof table.$inferSelect`, `keyof typeof policy`, cặp const/type cùng tên (`OrgRole`, `ErrorCode`). Tách ra thì hai thứ "là một" bị chia đôi.
- Kiểu **không export** (chi tiết nội bộ một file, vd `CursorPayload`) để tại chỗ. Export ra chỉ để dời chỗ là biến chi tiết nội bộ thành API công khai.
- File `*.types.ts` chỉ chứa kiểu, không có giá trị runtime. Hằng cần cho validate / Swagger enum để ở file riêng (vd `audit/audit-actions.ts`).
- Không làm thư mục `src/types/` chung: nó thành nơi mọi module cùng import vào, type trôi xa code dùng nó, và các module dính chéo nhau qua đó.
- Test kiến trúc `test/unit/architecture/types-location.spec.ts` canh các luật trên.

**ESM:** import tương đối **bắt buộc có đuôi `.js`** (`import { X } from './x.js'`), kể cả khi file nguồn là `.ts`. Không dùng `__dirname`, dùng `import.meta.dirname`. Không `require()`.

## 2. Xử lý lỗi & định dạng lỗi

Mọi lỗi trả về cùng một dạng:

```json
{
  "error": {
    "code": "CHANNEL_ARCHIVED",
    "statusCode": 409,
    "message": "Kênh đã được lưu trữ (chỉ đọc).",
    "details": [
      { "field": "name", "message": "name must be shorter than or equal to 80 characters" }
    ],
    "requestId": "01J9Z6..."
  }
}
```

| HTTP | `code` mặc định                                                                                                                                                                                                                             | Khi nào                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`, `INVALID_CURSOR`, `UPLOAD_PART_SIZE_MISMATCH`, `UPLOAD_PART_OUT_OF_RANGE`, `UPLOAD_PART_ABORTED`                                                                                                                       | DTO sai, cursor hỏng                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 401  | `UNAUTHENTICATED` (mặc định), `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_SESSION_REVOKED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_REFRESH_TOKEN_INVALID`, `AUTH_REFRESH_TOKEN_ROTATED`, `AUTH_REFRESH_TOKEN_REUSED` | Chưa xác thực được                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 403  | `FORBIDDEN`                                                                                                                                                                                                                                 | Thấy được tài nguyên nhưng không đủ quyền với hành động                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 404  | `NOT_FOUND`, `INVITE_NOT_FOUND` (mở link mời bằng token), `REPORT_NOT_FOUND`                                                                                                                                                                | Không tồn tại **hoặc không được thấy** (kênh riêng tư)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 410  | `GONE` (mặc định), `INVITE_EXPIRED`, `INVITE_EXHAUSTED`, `UPLOAD_EXPIRED`                                                                                                                                                                   | Tài nguyên từng hợp lệ nhưng không còn dùng được (link mời hết hạn / hết lượt). Khác 404 = chưa từng có hoặc đã thu hồi                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 409  | `CONFLICT` và mã cụ thể                                                                                                                                                                                                                     | Trùng unique, `AUTH_EMAIL_TAKEN`, `ORG_OWNER_IMMUTABLE`, `ORG_ALREADY_MEMBER`, `ORG_JOIN_REQUEST_PENDING`, `JOIN_REQUEST_NOT_PENDING`, `ORG_OWNER_MUST_TRANSFER`, `ORG_TRANSFER_INVALID_TARGET`, `ORG_MEMBER_OWNS_CHANNELS`, `CHANNEL_NAME_TAKEN`, `CHANNEL_ARCHIVED`, `CHANNEL_ALREADY_MEMBER`, `CHANNEL_OWNER_IMMUTABLE`, `CHANNEL_OWNER_MUST_TRANSFER`, `CHANNEL_TRANSFER_INVALID_TARGET`, `UPLOAD_NOT_ACTIVE`, `UPLOAD_INCOMPLETE`, `IDEMPOTENCY_IN_PROGRESS`, `REPORT_IN_PROGRESS`, `REPORT_REGENERATE_LIMIT`, sai trạng thái, hết quota |
| 411  | `LENGTH_REQUIRED`                                                                                                                                                                                                                           | Route nhận body dạng stream mà thiếu `Content-Length` (vd `Transfer-Encoding: chunked`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                                                                                                                         | Part quá lớn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                                                                    | Sai `Content-Type` (vd PUT phần upload không phải `application/octet-stream`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 422  | `IDEMPOTENCY_KEY_REUSED`                                                                                                                                                                                                                    | Cùng `Idempotency-Key` nhưng method / path / body khác lần đầu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 429  | `RATE_LIMITED`                                                                                                                                                                                                                              | Vượt rate limit (M11 B3) — kèm `Retry-After` (giây); giới hạn từng route ở 05-api                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 503  | `SERVICE_UNAVAILABLE`                                                                                                                                                                                                                       | Phụ thuộc (DB, Redis) không phản hồi; DB bận — chờ khoá quá `lock_timeout` (`55P03`) / câu lệnh quá `statement_timeout` (`57014`) → kèm `Retry-After: 1` (M11 B1)                                                                                                                                                                                                                                                                                                                                                                             |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                                                                            | Không lộ stack. Chỉ log phía server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Hiện thực:

- **Catalog lỗi `src/common/errors/errors.ts` (từ M4 B4b):** mọi lỗi trả về client được tạo ở đây, chia nhóm theo domain: `throw Errors.channel.archived()`. Module **không** tự `new AppException(...)` hay `throw new NotFoundException(...)`. Test kiến trúc `test/unit/architecture/errors-catalog.spec.ts` quét `src/` và đỏ nếu có.
  - Mỗi mục là một **hàm**, vì mỗi lần ném cần instance mới để stack trace đúng chỗ, và có lỗi nhận tham số (`details`).
  - Tra theo **tình huống**, không theo `code`: một `NOT_FOUND` có nhiều câu (không tìm thấy kênh / tổ chức…). Cùng ý thì dùng chung một mục (vd `Errors.role.cannotGrant()` cho tạo link, duyệt yêu cầu, thêm vào kênh).
  - Thêm lỗi mới: thêm mục vào catalog, cộng thêm `ErrorCode` nếu cần mã riêng (tiền tố domain).
  - Client dựa vào `code`. `message` dành cho người đọc, sửa câu chữ không làm vỡ client.
- `AppException(code, httpStatus, message?, details?)`: class lỗi nghiệp vụ, chỉ được khởi tạo trong catalog.
- Policy trả về **quyết định** (`'ok' | 'forbidden' | …`), không ném lỗi. Hàm `assert…Decision` trong module đổi quyết định thành `Errors.*` (vd `channels/channel-decisions.ts`).
- `AllExceptionsFilter` (global) map các loại lỗi:
  - `AppException`: giữ nguyên.
  - `HttpException` của Nest (vd sai route, body-parser): map status sang code mặc định.
  - Lỗi Postgres `23505` (unique violation): `Errors.common.duplicate()` → 409 `CONFLICT`. Không có ngữ cảnh thì service nên tự bắt để trả mã cụ thể.
  - Lỗi Postgres `23503` (FK violation): `Errors.common.referenceInvalid()` → 409.
  - Lỗi khác: `Errors.common.internal()` → 500 và log `error`.
- `requestId` lấy từ pino-http (`req.id`), đồng thời trả header `x-request-id`.

## 3. Định dạng response

Mọi response **thành công** có cùng một vỏ `{ data, meta }` (từ M4 B4e):

```json
{ "data": { "id": "…", "name": "Kỹ thuật" }, "meta": { "statusCode": 200, "requestId": "01J9Z6…" } }
```

```json
{
  "data": [{ "id": "…" }, { "id": "…" }],
  "meta": { "statusCode": 200, "requestId": "01J9Z6…", "nextCursor": "eyJ2IjoxLC…" }
}
```

- **Một tài nguyên:** `data` là object. **Danh sách:** `data` là mảng thuần, `meta.nextCursor` để lấy trang sau (`null` = hết). Không trả `total`, vì `COUNT(*)` trên bảng lớn tốn kém và không đi cùng keyset pagination.
- **`meta.statusCode`** luôn trùng HTTP status thật (đọc từ response, không gán cứng): tạo mới → `201`. **`meta.requestId`** trùng header `x-request-id` và `error.requestId`.
- **Lỗi** giữ vỏ riêng `{ error: { code, statusCode, message, details?, requestId } }` (§2): có `data` là thành công, có `error` là lỗi, không cần cờ `success`.
- **Hành động không trả gì:** `204 No Content`, không có body (không bọc).
- **Ngoại lệ:** `/health/*` trả body thô (`@RawResponse()`), vì probe của Docker / K8s đọc thẳng `{ status }`.
- **Hiện thực:** controller / service KHÔNG tự bọc. Chúng vẫn trả DTO hoặc `Page<T>`. `ResponseEnvelopeInterceptor` (global, đăng ký trong `configureApp`) bọc ở ranh giới HTTP; danh sách được nhận biết bằng metadata của `@ApiPaginatedResponse`. Swagger được bọc tương ứng trong `buildOpenApiDocument` (`applyResponseEnvelope`), dựa trên cùng các đánh dấu (`x-paginated`, `x-raw-response`). Test kiến trúc `openapi-envelope.spec.ts` kiểm tra mọi response 2xx JSON trong `openapi.json`.
- **`Idempotency-Key` (M5 B6)** cho POST **không tự idempotent** (hiện có: init upload). Gắn `@Idempotent()` (`src/modules/idempotency/`), module của controller import `IdempotencyModule`.
  - Header tuỳ chọn, 1–255 ký tự ASCII in được, **theo từng user**, giữ 24 giờ. Sai dạng → 400 `VALIDATION_FAILED` (`details[0].field = headers.idempotency-key`).
  - Cùng key + cùng method / path / body (JSON so sau khi **sắp xếp field**) → trả lại đúng status + `data` lần đầu, `meta.requestId` là của request mới, kèm header `Idempotent-Replayed: true`. Body khác → 422 `IDEMPOTENCY_KEY_REUSED`. Request đầu chưa xong → 409 `IDEMPOTENCY_IN_PROGRESS` (thử lại sau).
  - **Lỗi không được ghi nhớ:** handler lỗi (kể cả 400 validate) → xoá chỗ giữ, sửa rồi gửi lại cùng key được.
  - Không gắn cho route **tự idempotent theo trạng thái** (complete upload, PUT part) và route trả **bí mật** (response lưu nguyên văn trong DB).
- Thời gian dạng ISO 8601 UTC (`2026-10-13T01:00:00.000Z`). `weekStart` dạng `YYYY-MM-DD`.
- Không trả row DB trực tiếp. Luôn map sang `*ResponseDto` để tránh lộ `password_hash` và để Swagger đọc được kiểu.

## 4. Phân trang cursor

- Query: `cursor` (opaque string), `limit` (1–100, mặc định 20).
- Cursor = `base64url(JSON.stringify({ v: 1, k: [<giá trị cột sort>…, <id>] }))`. Client không được tự parse.
- Mỗi danh sách cố định **một** thứ tự sort có **tie-breaker duy nhất** (thường là `id`), và có index khớp đúng thứ tự đó.
- Query dùng so sánh tuple `(a, b) > ($1, $2)`, lấy `limit + 1` dòng. Có dòng thừa thì có `nextCursor`.
- Cursor không decode được, sai số phần tử, hoặc **từng khoá sai định dạng** (cursor bị sửa tay) thì `400 INVALID_CURSOR`. Kiểm tra khoá bằng `expectTimestampKey` / `expectUuidKey` (`common/pagination/keys.ts`) **trước** khi đưa vào SQL. Nếu không, Postgres ném lỗi ép kiểu và trả 500.

> **Bẫy:**
>
> 1. Sort theo cột không duy nhất (vd `joined_at`) mà không có tie-breaker thì trang sau bị lặp hoặc mất dòng.
> 2. Sort `DESC` thì so sánh tuple phải đổi thành `<`. Trộn ASC/DESC giữa các cột thì không dùng được so sánh tuple, phải viết điều kiện OR.
> 3. `timestamptz` có độ chính xác micro giây, còn JS `Date` chỉ có milli giây. Khoá thời gian lấy bằng `timestampKey(column)`: Postgres sinh ISO 8601 UTC đủ micro giây (`to_char … US`). **Không** đi qua `Date`, nếu không trang sau bị mất dòng.
> 4. Tìm bằng `LIKE` thì phải `escapeLike()` chuỗi người dùng nhập và viết `ESCAPE '\'`. Nếu không, `%` khớp mọi dòng và `_` khớp mọi ký tự.

## 5. Versioning

- URI versioning: `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`, nên mọi route là `/v1/...`.
- Health và docs đặt `VERSION_NEUTRAL` hoặc nằm ngoài router.
- Thay đổi breaking thì tạo controller `@Version('2')` cho route đó. Thêm field mới là non-breaking, giữ v1.

## 6. Biến môi trường

Validate khi khởi động bằng class `EnvironmentVariables` (class-validator). Thiếu hoặc sai thì **dừng tiến trình** với thông báo rõ ràng. File `.env.example` liệt kê đủ biến.

| Biến                                                            | Mốc | Mặc định                        | Ghi chú                                                                                                                                                                                                    |
| --------------------------------------------------------------- | --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                      | M0  | `development`                   | `development \| test \| staging \| production`                                                                                                                                                             |
| `PORT`                                                          | M0  | `3000`                          |                                                                                                                                                                                                            |
| `LOG_LEVEL`                                                     | M0  | `info`                          |                                                                                                                                                                                                            |
| `LOG_PRETTY`                                                    | M0  | `false`                         | `true` khi dev local                                                                                                                                                                                       |
| `DATABASE_URL`                                                  | M0  | –                               | `postgres://user:pass@host:5432/db`                                                                                                                                                                        |
| `DATABASE_POOL_MAX`                                             | M0  | `10`                            |                                                                                                                                                                                                            |
| `MIGRATION_DATABASE_URL`                                        | M11 | (dùng `DATABASE_URL`)           | Script migrate kết nối bằng CHỦ schema; app thì không (`DATABASE_URL` = user đăng nhập riêng của api / worker)                                                                                             |
| `DB_API_PASSWORD`, `DB_WORKER_PASSWORD`                         | M11 | —                               | Có cả hai → script migrate tạo / cập nhật `meetnote_api_login` / `meetnote_worker_login`. Giá trị trong compose / `.env.example` chỉ cho local                                                             |
| `DATABASE_LOCK_TIMEOUT_MS`                                      | M11 | `3000`                          | `lock_timeout` cho mọi connection của tiến trình. Phải **nhỏ hơn** `DATABASE_IDLE_TX_TIMEOUT_MS` (kiểm lúc khởi động)                                                                                      |
| `DATABASE_STATEMENT_TIMEOUT_MS`                                 | M11 | `15000`                         | `statement_timeout`; worker trong compose đặt `60000` (job theo lô)                                                                                                                                        |
| `DATABASE_IDLE_TX_TIMEOUT_MS`                                   | M11 | `30000`                         | `idle_in_transaction_session_timeout`: transaction bỏ dở bị Postgres cắt session, nhả khoá                                                                                                                 |
| `REDIS_URL`                                                     | M0  | –                               | `redis://host:6379`                                                                                                                                                                                        |
| `JWT_ACCESS_SECRET`                                             | M1  | –                               | ≥ 32 ký tự                                                                                                                                                                                                 |
| `JWT_ACCESS_TTL_SECONDS`                                        | M1  | `900`                           |                                                                                                                                                                                                            |
| `REFRESH_TOKEN_TTL_DAYS`                                        | M1  | `30`                            | Trượt: tính từ lần refresh gần nhất                                                                                                                                                                        |
| `REFRESH_REUSE_GRACE_SECONDS`                                   | M1  | `10`                            | Token vừa xoay bị dùng lại trong khoảng này thì không coi là bị đánh cắp                                                                                                                                   |
| `S3_ENDPOINT`                                                   | M5  | –                               | S3 tương thích, vd RustFS `http://localhost:9000`. Bỏ trống khi dùng AWS S3                                                                                                                                |
| `S3_REGION`                                                     | M5  | `us-east-1`                     |                                                                                                                                                                                                            |
| `S3_BUCKET`                                                     | M5  | –                               |                                                                                                                                                                                                            |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                      | M5  | –                               | Local khớp `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` trong `compose.yaml`                                                                                                                                  |
| `S3_FORCE_PATH_STYLE`                                           | M5  | `false`                         | `true` cho RustFS / MinIO                                                                                                                                                                                  |
| `S3_CREATE_BUCKET`                                              | M5  | `false`                         | `true` ở dev / compose: tạo bucket lúc khởi động. Production: hạ tầng tạo sẵn                                                                                                                              |
| `REALTIME_CORS_ORIGINS`                                         | M7  | rỗng                            | Origin trang web được mở socket `/realtime`, cách nhau dấu phẩy. Kiểm `Origin` ở `allowRequest` (trình duyệt không áp CORS cho WebSocket); client không gửi `Origin` (không phải trình duyệt) vẫn vào được |
| `REALTIME_REDIS_KEY`                                            | M7  | `meetnote:socket.io`            | Kênh Redis của Socket.IO adapter + emitter. Hai môi trường dùng chung Redis phải khác key; test e2e đặt key ngẫu nhiên mỗi file                                                                            |
| `QUEUE_PREFIX`                                                  | M10 | `meetnote`                      | Tiền tố key BullMQ. Hai môi trường dùng chung Redis phải khác prefix (worker bên này sẽ lấy job bên kia); test e2e đặt ngẫu nhiên mỗi file                                                                 |
| `RATE_LIMIT_ENABLED`                                            | M11 | `true`                          | Tắt rate limit (test e2e đặt `false`, file test rate limit bật lại)                                                                                                                                        |
| `RATE_LIMIT_PREFIX`                                             | M11 | `meetnote:rate-limit`           | Tiền tố khoá rate limit trong Redis; hai môi trường chung Redis phải khác                                                                                                                                  |
| `TRUST_PROXY_HOPS`                                              | M11 | `0`                             | Số tầng reverse proxy trước api (Express `trust proxy`). 0 = bỏ qua `X-Forwarded-For` (client giả được). Đặt đúng số tầng                                                                                  |
| `FFMPEG_PATH`, `FFPROBE_PATH`                                   | M6  | `ffmpeg`, `ffprobe`             | Binary của ffmpeg (tìm trong PATH nếu không ghi đường dẫn)                                                                                                                                                 |
| `WORKER_QUEUES`                                                 | M6  | `default,transcription`         | Queue worker này nghe; tách worker chuyên whisper bằng `transcription`                                                                                                                                     |
| `WORKER_SCHEDULES_ENABLED`                                      | M6  | `true`                          | Worker đăng ký lịch chạy (Job Scheduler) lúc khởi động; nhiều worker vẫn một lịch. Test e2e tắt (`createTestWorker({ schedules: true })` bật riêng)                                                        |
| `SPEECH_PROVIDER`                                               | M6  | `whisper`                       | `whisper` (whisper.cpp) hoặc `fake`                                                                                                                                                                        |
| `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`                        | M6  | `whisper-cli`, (trống)          | Model ggml; KHÔNG bắt buộc lúc khởi động (api dùng chung validate) — worker thiếu model → lỗi cấu hình khi chạy                                                                                            |
| `WHISPER_LANGUAGE`, `WHISPER_THREADS`, `WHISPER_TIMEOUT_FACTOR` | M6  | `auto`, (mặc định whisper), `3` | Hạn chạy whisper = thời lượng audio × hệ số + 2 phút                                                                                                                                                       |
| `LLM_PROVIDER`                                                  | M6  | `fake`                          | `anthropic` mới gửi transcript lên Claude API (M6 Q2)                                                                                                                                                      |
| `ANTHROPIC_API_KEY`                                             | M6  | (trống)                         | SDK Anthropic tự đọc (không qua `env.validation`); chỉ cần khi `LLM_PROVIDER=anthropic`                                                                                                                    |
| `LLM_MODEL`, `LLM_EFFORT`                                       | M6  | `claude-opus-5-5`, `medium`     | Effort đặt tường minh (mặc định của mỗi model khác nhau)                                                                                                                                                   |

Swagger **không có biến bật/tắt riêng**. Swagger bật khi `NODE_ENV ∈ {development, test, staging}` và luôn tắt ở `production`, để không thể vô tình bật trên production.

### Truy cập DB: role, RLS, timeout (M11)

- Api / worker kết nối bằng user riêng, chỉ DML (03 §0). Migration chạy bằng chủ schema (`MIGRATION_DATABASE_URL`).
- Bảng có RLS (03 §0): ngoài route `/orgs/:orgId`, bọc `OrgContext.runInOrg(orgId, fn)` — thiếu ngữ cảnh thì truy vấn trả **rỗng** và UPDATE / DELETE đổi **0 dòng**, KHÔNG có lỗi. Worker (`BYPASSRLS`) không cần.
- Bảng mới mang `org_id` và chỉ đọc trong ngữ cảnh một tổ chức → `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy `org_id = app_current_org_id()` trong migration. Bảng chỉ-ghi-thêm → `REVOKE UPDATE, DELETE` khỏi `meetnote_app` / `meetnote_worker`.
- Test: dữ liệu nền / kiểm tra DB qua `fixtureDb()` (e2e) hoặc `createTestDb()` (integration) — user worker, bỏ qua RLS; test cần đúng user api truyền `process.env.DATABASE_URL`.
- Mọi connection có `lock_timeout` 3 s / `statement_timeout` 15 s / idle-in-transaction 30 s; `55P03` / `57014` → 503. Job theo lô dài hơn: chỉnh env của worker, đừng tắt timeout.

## 7. Viết DTO để Swagger sinh đúng

Bật `@nestjs/swagger` CLI plugin trong `nest-cli.json` (`introspectComments: true`, `classValidatorShim: true`). Plugin đọc kiểu TS + class-validator + JSDoc để sinh schema. Quy tắc:

1. **DTO phải là `class`** và đặt trong file **`*.dto.ts`**. Plugin chỉ quét file có hậu tố `.dto.ts` / `.entity.ts`. Interface hoặc `type` sẽ không có schema.
2. Mô tả bằng **JSDoc**, không cần `@ApiProperty({ description })`:
   ```ts
   export class CreateChannelDto {
     /** Tên kênh, duy nhất trong tổ chức (không phân biệt hoa thường). @example "backend-team" */
     @IsString()
     @Length(1, 80)
     name!: string;

     /** Kênh riêng tư chỉ thành viên mới thấy nội dung. */
     @IsEnum(ChannelVisibility)
     visibility: ChannelVisibility = ChannelVisibility.Public;
   }
   ```
3. **Enum:** khai báo `enum` TS hoặc `as const` object và thêm `@ApiProperty({ enum: X, enumName: 'X' })`. Có `enumName` thì schema enum được tách ra dùng chung, client sinh ra 1 kiểu duy nhất thay vì nhiều kiểu inline.
4. **Generic** (`PaginatedDto<T>`): plugin không hiểu generic. Dùng decorator `@ApiPaginatedResponse(ItemDto)` (có sẵn ở `common/swagger`), bên trong dùng `ApiExtraModels` + `getSchemaPath` + `allOf`.
5. **Lỗi:** dùng `@ApiErrorResponses(400, 401, 403, 404, 409)`. Decorator này gắn `ErrorResponseDto` cho từng status.
6. **Field tuỳ chọn:** dùng `?` trong TS + `@IsOptional()`. Plugin tự đánh `required: false`.
7. **Lồng DTO:** `@ValidateNested() @Type(() => ChildDto)`. Mảng thì thêm `{ each: true }`.
8. **Query:** dùng DTO class + `@Query() q: ListChannelsQueryDto`. Số trong query là string, nên phải `@Type(() => Number)`.
9. **Mô tả endpoint:** JSDoc trên method của controller. Câu đầu thành `summary`. Thẻ `@remarks …` thành `description`. Kiểu trả về của method được plugin suy ra thành response 200/201, nên luôn khai báo kiểu trả về tường minh (`Promise<XxxResponseDto>`).

> **Bẫy:**
>
> - `enableImplicitConversion: true` biến chuỗi `"false"` thành `true`. Dự án **tắt** implicit conversion và dùng `@Type`/`@Transform` tường minh.
> - `import type { XDto }` trong DTO khác làm mất metadata runtime (`emitDecoratorMetadata` cần tham chiếu giá trị). Dùng import thường cho class DTO.
> - Plugin chỉ chạy khi build bằng `nest build`/`nest start`. Vitest (dùng Oxc transform) **không chạy plugin**. Test nào cần kiểm tra schema thì phải chạy trên bản build (`dist/`), hoặc dùng `@ApiProperty` thủ công.
> - Plugin không đọc DTO ở file không đúng hậu tố, nên `response.ts` sẽ không có schema.

## 8. Logging

- pino JSON lên stdout. Dev bật `LOG_PRETTY=true` để dùng pino-pretty.
- Mỗi request có `reqId`, lấy từ header `x-request-id` nếu client gửi và hợp lệ, nếu không thì sinh UUID mới. Trả lại trong header.
- Job worker log kèm `jobId`, `queue`, `meetingId`. Truyền `requestId` vào payload job để nối log api → worker.
- Redact `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.refreshToken`.

## 9. Git

- Conventional Commits: `feat(channels): transfer ownership with row lock`.
- Mỗi mốc một nhánh `m2-organizations`. Merge khi CI xanh và đã tick hết checklist trong `docs/plans/Mx-*.md`.
