# CLAUDE.md

Hướng dẫn cho Claude Code khi làm việc trong repo này.

## Dự án

MeetNote là ứng dụng biên bản họp theo nhóm. Người dùng thuộc tổ chức, tổ chức có kênh. Cuộc họp được upload, Whisper chuyển thành transcript, AI tóm tắt, và mỗi tuần hệ thống tổng hợp báo cáo cho từng kênh.

**Đây là project học sâu, không phải project làm nhanh.** Vì vậy:

- Trả lời bằng **tiếng Việt**, thuật ngữ kỹ thuật giữ tiếng Anh.
- Khi viết code, giải thích ngắn **vì sao** chọn cách đó, **phương án thay thế** nếu đáng kể, và **bẫy** đang tránh.
- Mọi phần việc chia thành mốc. **Viết plan vào `docs/plans/` trước khi code** và chờ người dùng duyệt (skill `milestone-workflow`).
- Gặp bẫy thật thì ghi vào mục "Điều học được / bẫy gặp phải" của plan đang làm.

## Trạng thái

| Mốc                            | Trạng thái                                                              |
| ------------------------------ | ----------------------------------------------------------------------- |
| M0 — Khung                     | **Xong**. CI xanh, e2e + Docker Compose đã chạy trên máy dev (OrbStack) |
| M1 — Auth                      | **Xong** (PR #1 đã merge)                                               |
| M2 — Tổ chức                   | **Xong** (PR #2)                                                        |
| M3 — Mời, duyệt, sở hữu, audit | **Xong** (PR #3)                                                        |
| M4 — Kênh                      | **Xong** (PR #4). Mốc tiếp theo: M5 — Upload                            |

Lộ trình đầy đủ: `docs/design/10-roadmap.md`.

## Lệnh

```bash
pnpm install
pnpm start:dev            # api (watch)      → http://localhost:3000/docs
pnpm start:worker         # worker (watch)
pnpm test                 # unit, không cần Docker
pnpm test:e2e             # integration + e2e, Testcontainers (CẦN Docker)
pnpm lint                 # oxlint --type-aware
pnpm typecheck            # tsc --noEmit
pnpm format               # prettier --write
pnpm build && pnpm openapi:export   # cập nhật openapi.json (CI kiểm tra khớp code)
pnpm db:generate --name=x           # migration từ schema Drizzle; --custom để viết SQL tay
pnpm db:studio                      # Drizzle Studio xem DB dev → https://local.drizzle.studio (README: Xem database)
pnpm build && pnpm db:migrate       # chạy migration (đọc .env)
docker compose up -d postgres redis rustfs   # hạ tầng cho dev local
```

Không có pnpm global thì dùng `npx -y pnpm@12.11.2 <lệnh>`. Kiểm tra trước khi báo xong: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, cộng thêm `pnpm test:e2e` nếu có Docker. **Không báo pass cho lệnh chưa chạy.**

## Kiến trúc tóm tắt

- **Một codebase, hai tiến trình:** `src/main.ts` (api: HTTP + Swagger, sau này Socket.IO) và `src/worker.ts` (application context, BullMQ processors, không HTTP). Hạ tầng dùng chung nằm trong `src/core.module.ts`.
- **api → worker chỉ qua queue** (BullMQ/Redis). **worker → client qua Redis** (socket.io redis-emitter, M7).
- `src/common/`: lỗi (catalog `Errors`, `AppException`, `ErrorCode`, `AllExceptionsFilter`), phân trang cursor, decorator Swagger.
- `src/infra/`: database (Drizzle + `pg`), redis, queue, logger. Sau này thêm storage, speech, llm.
- `src/modules/<domain>/`: controller → service → repository, cùng policy thuần.
- `migrations/`: SQL (drizzle-kit + viết tay). Chạy bằng service `migrate`, **không** chạy lúc app khởi động.
- `test/`: **mọi test nằm ở đây, không đặt trong `src/`**. `unit/` và `integration/` mô phỏng cây `src/`, `e2e/` test qua HTTP, `support/` là Testcontainers setup + factory. Mỗi file test có một database riêng clone từ template.

## Quy tắc bắt buộc (vi phạm là hỏng build hoặc gây bug khó thấy)

- **ESM:** import tương đối phải có đuôi `.js`. Dùng `import.meta.dirname`, không dùng `__dirname`.
- **DI:** class được inject theo kiểu constructor phải import **giá trị**, không được `import type`. Token Symbol (`DRIZZLE`, `REDIS`) đi kèm `@Inject()`.
- **Thư mục:** trong một thư mục có từ 2 file cùng vai trò (`*.service.ts`, `*.repository.ts`, `*.controller.ts`, `*.types.ts`) thì gom vào `services/`, `repositories/`, `controllers/`, `types/`. Chỉ 1 file thì để ở cấp module (test kiến trúc chặn).
- **Type:** interface / type viết tay được export nằm trong `<module>.types.ts`. Kiểu suy ra từ giá trị (`typeof`, `$inferSelect`, cặp const/type cùng tên) để cạnh giá trị. File types không chứa giá trị runtime (test kiến trúc chặn).
- **DTO:** là `class` trong file `*.dto.ts`, mô tả bằng JSDoc (Swagger CLI plugin đọc). Không trả row DB ra API, luôn map sang `*ResponseDto`. Method controller khai báo kiểu trả về tường minh.
- **Lỗi:** ném lỗi lấy từ catalog `src/common/errors/errors.ts` (`throw Errors.channel.archived()`). Lỗi mới thì thêm mục vào catalog. **Không** tự `new AppException(...)` ở module (test kiến trúc chặn). Tài nguyên ẩn trả **404**, không trả 403.
- **Response:** thành công là `{ data, meta: { statusCode, requestId } }`, lỗi là `{ error: { code, statusCode, … } }`. Controller / service **không tự bọc**: trả DTO hoặc `Page<T>`, interceptor toàn cục bọc. Route danh sách phải có `@ApiPaginatedResponse(Dto)`.
- **Danh sách:** phân trang cursor (`meta.nextCursor`), dùng `CursorQueryDto` + `toPage`. Timestamp trong cursor lấy dạng text từ DB.
- **Transaction:** thay đổi quyền/sở hữu thì khoá dòng cha trước, khoá theo thứ tự id, **kiểm tra lại sau khi khoá**, audit trong cùng transaction, publish/enqueue **sau commit**.
- **BullMQ:** payload chỉ chứa ID. `jobId = <tên-job>.<id>[.<lần>]`, **không có `:`**. Processor phải idempotent, và chỉ được đăng ký trong `WorkerModule`.
- **Schema:** đặt tên mọi constraint. Enum dùng `text` + `CHECK`. Bảng con có composite FK theo `org_id`. Không sửa migration đã commit.
- **Phiên bản:** TypeScript giữ `~6.0` (chưa dùng TS 7, vì `@nestjs/swagger` chưa hỗ trợ). Thêm dependency thì theo skill `add-dependency`.
- **Git:** chỉ commit/push khi người dùng yêu cầu. Conventional Commits, mỗi mốc một nhánh.

## Tài liệu

`docs/README.md` là mục lục. Hay dùng nhất:

- `docs/design/03-database.md`: bảng, index, chỗ cần khoá
- `docs/design/04-authorization.md`: ma trận quyền
- `docs/design/05-api.md`: danh sách API
- `docs/design/07-conventions.md`: quy ước
- `docs/plans/`: plan từng mốc

Code khác tài liệu thì **sửa tài liệu trong cùng thay đổi** và nói rõ với người dùng.

## Skills

Skill riêng của dự án (`.claude/skills/`). Dùng khi việc đang làm khớp mô tả:

| Skill                | Khi nào                                               |
| -------------------- | ----------------------------------------------------- |
| `milestone-workflow` | Bắt đầu / tiếp tục / đóng một mốc, lên plan           |
| `nest-endpoint`      | Thêm/sửa endpoint, DTO, module, phân trang            |
| `drizzle-schema`     | Thêm/sửa bảng, cột, index, migration                  |
| `db-transactions`    | Transaction, khoá dòng, idempotency, test concurrency |
| `authorization`      | Guard, policy, vai trò, ma trận quyền                 |
| `bullmq-jobs`        | Queue, processor, cron, pipeline xử lý                |
| `testing`            | Viết/chạy/sửa unit, integration, e2e test             |
| `add-dependency`     | Thêm/nâng cấp thư viện, lỗi pnpm                      |

Plugin khai báo trong `.claude/settings.json`. Claude Code gợi ý cài khi mở repo:

| Plugin            | Dùng cho                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superpowers`     | Quy trình: brainstorming, writing-plans, test-driven-development, systematic-debugging, verification-before-completion, requesting/receiving-code-review |
| `feature-dev`     | Agent khám phá code / thiết kế kiến trúc / review                                                                                                        |
| `code-review`     | `/code-review` cho thay đổi hoặc PR                                                                                                                      |
| `commit-commands` | `/commit`, `/commit-push-pr`                                                                                                                             |
| `skill-creator`   | Tạo/sửa skill trong `.claude/skills/`                                                                                                                    |
| `typescript-lsp`  | Language server TypeScript                                                                                                                               |
| `context7`        | Tra tài liệu mới nhất của NestJS 12, Drizzle, BullMQ… (cần đăng nhập)                                                                                    |
| `supabase`        | Chỉ dùng skill `supabase-postgres-best-practices` (Postgres nói chung). Dự án **không** dùng Supabase                                                    |

Khi skill dự án và skill quy trình của superpowers cùng áp dụng, skill dự án quyết định _cách làm trong repo này_. Riêng việc viết plan thì theo `milestone-workflow` (lưu ở `docs/plans/`).
