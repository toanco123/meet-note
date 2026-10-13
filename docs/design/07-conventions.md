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

**ESM:** import tương đối **bắt buộc có đuôi `.js`** (`import { X } from './x.js'`), kể cả khi file nguồn là `.ts`. Không dùng `__dirname`, dùng `import.meta.dirname`. Không `require()`.

## 2. Xử lý lỗi & định dạng lỗi

Mọi lỗi trả về cùng một dạng:

```json
{
  "error": {
    "code": "CHANNEL_ARCHIVED",
    "message": "Kênh đã được lưu trữ, không thể thay đổi.",
    "details": [
      { "field": "name", "message": "name must be shorter than or equal to 80 characters" }
    ],
    "requestId": "01J9Z6..."
  }
}
```

| HTTP | `code` mặc định                                                                                                                                                                                                                             | Khi nào                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`, `INVALID_CURSOR`                                                                                                                                                                                                       | DTO sai, cursor hỏng                                                                  |
| 401  | `UNAUTHENTICATED` (mặc định), `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_SESSION_REVOKED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_REFRESH_TOKEN_INVALID`, `AUTH_REFRESH_TOKEN_ROTATED`, `AUTH_REFRESH_TOKEN_REUSED` | Chưa xác thực được                                                                    |
| 403  | `FORBIDDEN`                                                                                                                                                                                                                                 | Thấy được tài nguyên nhưng không đủ quyền với hành động                               |
| 404  | `NOT_FOUND`                                                                                                                                                                                                                                 | Không tồn tại **hoặc không được thấy** (kênh riêng tư)                                |
| 409  | `CONFLICT` và mã cụ thể                                                                                                                                                                                                                     | Trùng unique, `ORG_OWNER_IMMUTABLE` (đổi vai trò/gỡ Owner), sai trạng thái, hết quota |
| 413  | `PAYLOAD_TOO_LARGE`                                                                                                                                                                                                                         | Part quá lớn                                                                          |
| 429  | `RATE_LIMITED`                                                                                                                                                                                                                              | (mốc hardening)                                                                       |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                                                                            | Không lộ stack. Chỉ log phía server                                                   |

Hiện thực:

- `AppException(code, httpStatus, message?, details?)`: service ném lỗi nghiệp vụ bằng class này.
- `AllExceptionsFilter` (global) map các loại lỗi:
  - `AppException`: giữ nguyên.
  - `HttpException` của Nest: map status sang code mặc định.
  - Lỗi Postgres `23505` (unique violation): 409 `CONFLICT`. Không có ngữ cảnh thì service nên tự bắt để trả mã cụ thể.
  - Lỗi Postgres `23503` (FK violation): 409.
  - Lỗi khác: 500 và log `error`.
- `requestId` lấy từ pino-http (`req.id`), đồng thời trả header `x-request-id`.

## 3. Định dạng response

- **Một tài nguyên:** trả thẳng object, không bọc `{ data }`.
- **Danh sách:** `{ "data": [...], "nextCursor": "eyJ2IjoxLC..." | null }`. Không trả `total`, vì `COUNT(*)` trên bảng lớn tốn kém và không đi cùng keyset pagination.
- **Hành động không trả gì:** `204 No Content`.
- **Tạo mới:** `201` + object.
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

| Biến                                                                                                       | Mốc | Mặc định                        | Ghi chú                                                                  |
| ---------------------------------------------------------------------------------------------------------- | --- | ------------------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                                                                                                 | M0  | `development`                   | `development \| test \| staging \| production`                           |
| `PORT`                                                                                                     | M0  | `3000`                          |                                                                          |
| `LOG_LEVEL`                                                                                                | M0  | `info`                          |                                                                          |
| `LOG_PRETTY`                                                                                               | M0  | `false`                         | `true` khi dev local                                                     |
| `DATABASE_URL`                                                                                             | M0  | –                               | `postgres://user:pass@host:5432/db`                                      |
| `DATABASE_POOL_MAX`                                                                                        | M0  | `10`                            |                                                                          |
| `REDIS_URL`                                                                                                | M0  | –                               | `redis://host:6379`                                                      |
| `JWT_ACCESS_SECRET`                                                                                        | M1  | –                               | ≥ 32 ký tự                                                               |
| `JWT_ACCESS_TTL_SECONDS`                                                                                   | M1  | `900`                           |                                                                          |
| `REFRESH_TOKEN_TTL_DAYS`                                                                                   | M1  | `30`                            | Trượt: tính từ lần refresh gần nhất                                      |
| `REFRESH_REUSE_GRACE_SECONDS`                                                                              | M1  | `10`                            | Token vừa xoay bị dùng lại trong khoảng này thì không coi là bị đánh cắp |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` | M5  |                                 |                                                                          |
| `UPLOAD_MAX_BYTES`                                                                                         | M5  | `2147483648`                    |                                                                          |
| `WORKER_QUEUES`                                                                                            | M6  | `default,transcription`         | Queue mà worker này tiêu thụ                                             |
| `WHISPER_BIN`, `WHISPER_MODEL_PATH`, `WHISPER_THREADS`                                                     | M6  |                                 |                                                                          |
| `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`                                                                 | M6  | `fake`                          |                                                                          |
| `REPORT_CRON`, `REPORT_TZ`                                                                                 | M9  | `0 8 * * 1`, `Asia/Ho_Chi_Minh` |                                                                          |

Swagger **không có biến bật/tắt riêng**. Swagger bật khi `NODE_ENV ∈ {development, test, staging}` và luôn tắt ở `production`, để không thể vô tình bật trên production.

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
