# Checklist review theo luật MeetNote

Nguồn sự thật là `CLAUDE.md` và `docs/design/*.md`. Nếu checklist này lệch với chúng thì theo chúng và báo để sửa checklist.

Mức độ: **[Chặn]** vi phạm là hỏng build hoặc gây bug khó thấy; **[Sửa]** nên sửa trước khi merge; **[Gợi ý]** cải thiện.

## Chung (mọi PR)

- [Chặn] Import tương đối thiếu đuôi `.js`; dùng `__dirname` thay vì `import.meta.dirname`.
- [Chặn] Class được inject theo kiểu constructor mà import bằng `import type` (Nest không resolve được). Token Symbol (`DRIZZLE`, `REDIS`) phải đi kèm `@Inject()`.
- [Chặn] Test đặt trong `src/` (mọi test nằm ở `test/`).
- [Sửa] Thư mục có từ 2 file cùng vai trò (`*.service.ts`, `*.repository.ts`, `*.controller.ts`, `*.types.ts`) mà chưa gom vào `services/`, `repositories/`, `controllers/`, `types/`. Chỉ 1 file thì để ở cấp module.
- [Sửa] Interface/type viết tay được export không nằm trong `<module>.types.ts`; file types chứa giá trị runtime.
- [Sửa] Lint thêm cảnh báo mới (hiện đúng 6 cảnh báo cũ).
- [Sửa] Code khác tài liệu mà không sửa `docs/design/*` trong cùng PR.
- [Sửa] `openapi.json` không khớp code (`pnpm build && pnpm openapi:export`, diff phải rỗng).
- [Gợi ý] Commit không theo Conventional Commits; PR gộp nhiều mốc.

## DB / migration

- [Chặn] Sửa migration đã commit (phải tạo migration mới).
- [Chặn] Bảng thuộc tổ chức nhưng thiếu policy RLS cùng mẫu theo `app.org_id`.
- [Chặn] Bảng con thiếu composite FK theo `org_id`.
- [Sửa] Constraint/index không đặt tên (`<bảng>_<cột>_<pk|uq|fk|ck|idx>`).
- [Sửa] Enum không dùng `text` + `CHECK`.
- [Sửa] Thêm cột `NOT NULL` vào bảng có dữ liệu mà không có `DEFAULT`; đổi tên cột sinh `DROP` + `ADD`.
- [Sửa] Cột timestamp dùng làm cursor không lấy dạng text từ DB (mất micro giây).
- [Sửa] `pnpm format` làm đổi `migrations/meta/*` ngoài ý muốn.

## API (controller, DTO)

- [Chặn] Trả row DB thẳng ra API thay vì `*ResponseDto`.
- [Chặn] Controller/service tự bọc `{ data, meta }` (interceptor toàn cục lo việc này).
- [Chặn] Tự `new AppException(...)` ở module; phải ném lỗi từ catalog `Errors`. Lỗi mới thì thêm vào catalog.
- [Chặn] Tài nguyên ẩn trả 403 thay vì 404.
- [Sửa] Method controller thiếu kiểu trả về tường minh.
- [Sửa] Route danh sách thiếu `@ApiPaginatedResponse(Dto)`, không dùng `CursorQueryDto` + `toPage`.
- [Sửa] DTO không phải `class` trong `*.dto.ts`, mô tả không bằng JSDoc.
- [Sửa] Route nhạy cảm thiếu `@Throttle(RateLimit.x)`.
- [Sửa] Quyền kiểm tra sau validate đầu vào (permission phải xét trước).

## Phân quyền

- [Chặn] Ma trận quyền (`docs/design/04-authorization.md`), policy và bảng test e2e không khớp nhau.
- [Chặn] Guard dựa vào dữ liệu body (guard chạy trước pipe); kiểm tra theo đối tượng phải ở service sau khi khoá dòng.
- [Sửa] Nhét role vào JWT; hoặc cache membership mà không xoá cache khi đổi quyền.
- [Sửa] Điều kiện quyền xem meeting viết lại riêng thay vì dùng điều kiện SQL dùng chung.

## Transaction / concurrency

- [Chặn] Thay đổi quyền/sở hữu không khoá dòng cha trước, không khoá theo thứ tự id, hoặc không kiểm tra lại sau khi khoá (TOCTOU).
- [Chặn] Publish/enqueue trước commit; audit ghi ngoài transaction.
- [Chặn] Giữ transaction trong lúc gọi mạng/việc chạy lâu (S3, Whisper, LLM).
- [Sửa] Chỗ khoá không có test concurrency chứng minh cần thiết (bỏ khoá thì test phải đỏ).
- [Sửa] Retry tự động để che deadlock thay vì sửa thứ tự khoá.

## RLS

- [Chặn] Đọc/ghi `channels`, `channel_members`, `meetings`, `meeting_shares`, `uploads` (và bảng mới có RLS) ngoài route `/orgs/:orgId` mà không bọc `OrgContext.runInOrg`. Triệu chứng: 0 dòng, không lỗi.
- [Sửa] Fixture test dùng `app.get(DRIZZLE)` thay vì `fixtureDb()` / `createTestDb()`.

## BullMQ / worker

- [Chặn] Payload chứa dữ liệu lớn thay vì chỉ ID.
- [Chặn] `jobId` chứa `:`; `jobId` không có tên bước/số lần nên bị BullMQ nuốt (kể cả job đã completed).
- [Chặn] Processor đăng ký ngoài `WorkerModule` (api cũng sẽ tiêu thụ job).
- [Chặn] Processor không idempotent (append thay vì upsert/thay thế; không mở đầu bằng UPDATE có điều kiện).
- [Sửa] Lỗi vĩnh viễn không ném `UnrecoverableError`; lỗi tạm không retry/backoff.
- [Sửa] Cron dùng `@nestjs/schedule` cho việc phải chạy đúng một lần (phải dùng Job Scheduler); timezone không phải `Asia/Ho_Chi_Minh`.
- [Sửa] Enqueue thất bại sau commit không có job quét lại.

## Test

- [Sửa] Chỉ có happy path; thiếu ca lỗi, 403/404, biên.
- [Sửa] Test không chứng minh được giá trị: tạm bỏ logic/khoá/điều kiện mà test vẫn xanh (nên chạy thử đột biến vài chỗ then chốt).
- [Sửa] Test phụ thuộc thứ tự hoặc thời gian thật; không dọn dữ liệu; dùng chung DB giữa các file.
- [Gợi ý] Lệnh e2e cần ffmpeg: 6 file đã biết chỉ lỗi cục bộ khi thiếu ffmpeg (CI chạy được). Lỗi ngoài danh sách đó là lỗi thật.
