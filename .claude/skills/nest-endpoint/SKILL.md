---
name: nest-endpoint
description: Thêm hoặc sửa API endpoint và domain module NestJS trong MeetNote theo đúng quy ước của dự án — phân lớp controller/service/repository/policy, DTO viết cho Swagger CLI plugin, mã lỗi AppException, phân trang cursor, versioning /v1, import ESM có đuôi .js. Dùng khi tạo module mới, thêm route/controller/DTO, đổi request/response, thêm filter hoặc danh sách phân trang, ví dụ "thêm API tạo kênh", "viết endpoint list members", "tạo module organizations", "thêm field vào response", "sao Swagger không hiện schema". Use for any new or changed HTTP endpoint, DTO or Nest module in this repo.
---

# Thêm endpoint / module NestJS

Đọc trước những phần liên quan:

- `docs/design/05-api.md`: route, ai được gọi, tag
- `docs/design/07-conventions.md`: đặt tên, lỗi, response, phân trang, DTO cho Swagger
- `docs/design/02-architecture.md` §3–4: bố cục module

Ví dụ đầy đủ một module (controller + DTO + service + repository + test) ở [references/module-example.md](references/module-example.md). Đọc file này khi tạo module mới hoặc khi chưa chắc cách viết một lớp nào đó.

## Bố cục module

```
src/modules/<domain>/
├─ <domain>.module.ts
├─ <domain>.controller.ts     # chỉ HTTP: route, DTO, decorator Swagger. Không có logic
├─ <domain>.service.ts        # use-case: ranh giới transaction, gọi policy, ném AppException, ghi audit
├─ <domain>.repository.ts     # query Drizzle; mọi hàm nhận `DbExecutor` (db hoặc tx)
├─ <domain>.policy.ts         # hàm thuần (actor, target) → boolean
└─ dto/*.dto.ts               # request + response DTO
```

Domain cần chạy ở cả worker thì tách `<Domain>CoreModule` (service + repository, không controller) và `<Domain>Module` (controller, import Core). `WorkerModule` chỉ import Core.

## Checklist khi thêm một endpoint

1. **Route.**
   - Theo `05-api.md`. Tài nguyên thuộc org nằm dưới `/orgs/:orgId/...`.
   - Path kebab-case số nhiều. Hành động không phải CRUD thì dùng `POST /:id/<verb>`.
   - Version mặc định là `1`, không cần `@Version`. Health/docs dùng `VERSION_NEUTRAL`.
2. **DTO** (`*.dto.ts`, luôn là `class`):
   - Mô tả field bằng JSDoc, không viết `@ApiProperty({ description })`. Thẻ `@example` trong JSDoc cũng được plugin đọc.
   - Validate bằng class-validator. Field tuỳ chọn: `?` + `@IsOptional()`.
   - Số/boolean trong query là string, nên dùng `@Type(() => Number)` hoặc `@Transform` tường minh. Dự án **tắt** `enableImplicitConversion`.
   - Enum: `@ApiProperty({ enum: X, enumName: 'X' })` để schema dùng chung.
   - Lồng nhau: `@ValidateNested({ each? }) @Type(() => ChildDto)`.
   - Danh sách: query DTO `extends CursorQueryDto`.
3. **Response.**
   - Luôn map row DB sang `XxxResponseDto` (không trả row Drizzle, tránh lộ cột nhạy cảm và để Swagger đọc được kiểu).
   - Method controller phải có **kiểu trả về tường minh** (`Promise<XxxResponseDto>`), plugin dựa vào đó để sinh response 200/201.
   - Danh sách trả `Page<T>` (`{ data, nextCursor }`) + `@ApiPaginatedResponse(ItemDto)`.
   - Không trả gì: `@HttpCode(204)`.
4. **Swagger.**
   - `@ApiTags('<Tag>')` trên controller. Tag phải có trong `src/bootstrap/swagger.ts`.
   - `@ApiErrorResponses(...)` với đúng các status route này có thể trả.
   - JSDoc của method: câu đầu thành `summary`, `@remarks ...` thành `description`.
   - Từ M1 trở đi: `@ApiBearerAuth()` cho route cần đăng nhập.
5. **Lỗi.**
   - Service ném `new AppException(ErrorCode.Xxx, HttpStatus.Xxx, 'thông điệp')` hoặc dùng `AppException.notFound()` / `.forbidden()` / `.conflict(code, msg)`.
   - Mã lỗi mới thêm vào `src/common/errors/error-code.ts`, có tiền tố domain (`CHANNEL_ARCHIVED`).
   - Tài nguyên người gọi không được thấy thì trả **404**, không trả 403.
6. **Quyền.** Theo skill `authorization`: guard ở controller, kiểm tra theo đối tượng ở service.
7. **Transaction.** Thao tác ghi nhiều bảng hoặc đổi quyền thì theo skill `db-transactions`.
8. **Đăng ký module** vào `AppModule` (và Core module vào `WorkerModule` nếu worker cần).
9. **Test** theo skill `testing`:
   - unit cho policy/hàm thuần;
   - e2e cho route: status, body lỗi chuẩn, phân quyền dạng bảng.
10. **Tài liệu + hợp đồng.** Cập nhật `05-api.md`, chạy `pnpm build && pnpm openapi:export` và xem diff `openapi.json`.

## Phân trang cursor

- Mỗi danh sách cố định **một** thứ tự sort có tie-breaker duy nhất (`id`), và có index khớp đúng thứ tự đó.
- Repository lấy `limit + 1` dòng, điều kiện so sánh tuple: ``sql`(${t.joinedAt}, ${t.userId}) > (${a}::timestamptz, ${b}::uuid)` ``.
- Service gọi `toPage(rows, limit, (r) => [r.joinedAtText, r.userId])`.
- Cursor nhận vào thì decode bằng `decodeCursor(q.cursor, 2)`. Hàm này ném `INVALID_CURSOR` nếu cursor hỏng.
- Timestamp đưa vào cursor phải lấy dạng **text từ DB** (``sql<string>`${t.joinedAt}::text` ``). Đi qua JS `Date` là mất phần micro giây, và trang sau sẽ lặp hoặc mất dòng.

## Bẫy hay gặp

- **ESM:** import tương đối phải có `.js` (`./channels.service.js`). Không dùng `__dirname`, dùng `import.meta.dirname`.
- **DI theo kiểu:** class được inject qua kiểu constructor phải import **giá trị**, không được `import type`. Với `import type`, metadata thành `Object` và Nest báo không resolve được dependency. Token Symbol (`DRIZZLE`, `REDIS`) thì đi kèm `@Inject(TOKEN)`, nên kiểu có thể là `import type`.
- **Plugin chỉ quét `*.dto.ts` và `*.controller.ts`.** Đặt DTO ở file khác thì schema rỗng.
- **Vitest không chạy Swagger plugin.** Test kiểm tra schema OpenAPI phải chạy trên `dist/`.
- **`@Res()` không có `passthrough: true`** sẽ tắt interceptor và cơ chế serialize của Nest. Chỉ dùng khi cần đặt status động như health check, hoặc khi stream file.
- **Body lớn (upload part)** đọc dạng stream, không đi qua body-parser JSON.
