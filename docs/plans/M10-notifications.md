# M10 — Thông báo

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-21: ★ cho Q1–Q6 — người dùng xác nhận chưa cần Firebase)
- **Nhánh:** `m10-notifications`
- **Tài liệu thiết kế liên quan:** [01-overview khối 5](../design/01-overview.md), [03-database `notifications`](../design/03-database.md), [05-api Notifications, Realtime](../design/05-api.md), [06-flows §1.2, §2, §3](../design/06-flows.md), [10-roadmap M10](../design/10-roadmap.md)
- **Ghi chú:** làm trước M6 / M8 / M9 (đang hoãn) theo yêu cầu người dùng. Thông báo "meeting xử lý xong / lỗi" (M6) và "báo cáo tuần sẵn sàng" (M9) cắm vào khi làm các mốc đó — mốc này dựng cơ chế và dùng các sự kiện ĐÃ CÓ.

## Mục tiêu

Cuối mốc:

- người dùng nhận **thông báo in-app** cho các sự kiện đã có: được thêm vào kênh, trở thành / thôi là chủ kênh, yêu cầu vào tổ chức được duyệt, meeting mới được chia sẻ vào kênh mình ở;
- thông báo **không trùng** dù thao tác hay job chạy lại (`dedupe_key`), **không "ma"** khi thao tác rollback;
- API: danh sách (cursor, lọc tổ chức / chưa đọc), đếm chưa đọc, đọc một / đọc hết, xoá mềm;
- **đẩy realtime sau commit** qua hạ tầng M7 (`notification.created`), và đồng bộ "đã đọc" giữa các thiết bị của cùng người;
- **BullMQ processor đầu tiên chạy trong worker**: fan-out thông báo "meeting được chia sẻ" tới thành viên kênh, theo lô, idempotent.

## Ngoài phạm vi

- Thông báo meeting xử lý xong / lỗi (M6), báo cáo tuần (M9).
- Email / push mobile; tuỳ chọn tắt từng loại thông báo.
- Dọn thông báo cũ (> N ngày): lên lịch cùng các job dọn ở M6.

## Quyết định cần duyệt

| #   | Câu hỏi                                                                                                | Đề xuất ★                                                                                                                                                                                                                                                                                                                                               | Phương án khác                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Loại thông báo trong M10?                                                                              | ★ `channel.member_added` (người được thêm), `channel.ownership_transferred` (chủ mới + chủ cũ), `org.join_request_approved` (người xin vào), `meeting.shared` (thành viên kênh trừ người chia sẻ và **khách** — như "nhận thông báo báo cáo tuần" ở 04 §2)                                                                                              | Chỉ làm cơ chế + 1 loại; hoặc thêm nhiều loại (đổi vai trò, bị gỡ…)                                                                                                                                      |
| Q2  | Tạo thông báo ở đâu?                                                                                   | ★ **Ít người nhận (1–2)**: INSERT trong CÙNG transaction của thao tác (như audit) → thao tác rollback thì không có thông báo "ma"; đẩy realtime **sau commit**. **Nhiều người nhận** (thành viên kênh): enqueue job `notification.fanout` **sau commit**, worker INSERT theo lô `ON CONFLICT (user_id, dedupe_key) DO NOTHING`, đẩy realtime sau mỗi lô | Mọi loại đều qua job (đồng nhất nhưng thông báo cá nhân bị trễ, thêm phụ thuộc Redis cho thao tác đơn giản); mọi loại đều trong transaction (fan-out lớn làm transaction của request dài)                |
| Q3  | Rời / bị gỡ khỏi tổ chức thì thông báo cũ của tổ chức đó?                                              | ★ **Ẩn** khỏi danh sách / đếm: chỉ trả thông báo của tổ chức người dùng còn là thành viên (hoặc `org_id` NULL). Thông báo chứa tên kênh / meeting — người đã ra khỏi tổ chức không nên tiếp tục thấy                                                                                                                                                    | Giữ nguyên (lịch sử cá nhân)                                                                                                                                                                             |
| Q4  | Nội dung thông báo lưu gì?                                                                             | ★ `payload` = **id + tên lúc tạo** (vd `{ channelId, channelName, actorName }`): đọc danh sách không phải join nhiều bảng, đổi tên sau đó không làm sai câu chữ cũ; client cần chi tiết thì gọi REST (có kiểm quyền)                                                                                                                                    | Chỉ lưu id, ghép tên lúc đọc (luôn mới nhưng truy vấn danh sách nặng, và mục đã xoá thì trống)                                                                                                           |
| Q5  | Đếm chưa đọc chính xác tới đâu?                                                                        | ★ Chính xác tới 99, từ 100 trả `"99+"` (`count(*)` trên subquery `LIMIT 100`) — chi phí bị chặn dù người dùng có 100k thông báo chưa đọc                                                                                                                                                                                                                | Đếm chính xác hết (index partial vẫn phải quét đủ số dòng chưa đọc)                                                                                                                                      |
| Q6  | Gửi push qua **Firebase Cloud Messaging** (thông báo tới điện thoại / trình duyệt kể cả khi app đóng)? | ★ **Chưa làm ở M10**: dự án chưa có app client để nhận push, và 01-overview để push mobile ngoài phạm vi. Nhưng chừa sẵn chỗ cắm: thông báo sau khi lưu đi qua interface `NotificationChannel` — in-app (realtime) là kênh đầu tiên; FCM là một kênh thêm sau (job trong worker gọi `firebase-admin` sau commit, bảng `device_tokens`, dọn token chết)  | Làm FCM ngay trong M10: cần Firebase project + service account (secret), API đăng ký device token, job gửi + xử lý token hết hạn — mốc dài thêm khoảng 2 bước, nhưng chưa có client để thấy kết quả thật |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- `dedupe_key` dạng `<loại>.<id…>` (vd `meeting-shared.{meetingId}.{channelId}`) — cũng là phần đuôi `jobId` nên **không có `:`** (BullMQ cấm).
- Job fan-out **kiểm lại lúc chạy**: meeting đã bị gỡ khỏi kênh / bị xoá trước khi job chạy → không gửi. Người nhận = thành viên kênh LÚC JOB CHẠY (người vừa rời kênh không nhận).
- Realtime: `notification.created { …NotificationDto }` tới `user:{id}`; đọc / đọc hết → `notification.read { ids }` / `{ all: true, orgId }` tới `user:{id}` để thiết bị khác cập nhật số chưa đọc.
- Thông báo của người khác → **404** (tài nguyên ẩn). Đọc / xoá lại lần nữa → 204 (idempotent).
- Processor chỉ đăng ký trong `WorkerModule` (qua `NotificationsWorkerModule`); tách `NotificationsCoreModule` (repository + service) dùng chung api + worker.

## Thay đổi thiết kế

- Bảng `notifications` như 03 §6: thêm CHECK `type`, FK `user_id` ON DELETE CASCADE, index đúng như 03 (+ tên constraint).
- 05-api Notifications: chốt tham số + response; Realtime: `notification.created`, `notification.read`.

## Các bước

- [x] **B1 — Schema + migration**
  - Test (integration): unique partial `(user_id, dedupe_key)` (NULL không đụng nhau), CHECK `type`, EXPLAIN đếm chưa đọc dùng index partial.
- [ ] **B2 — Tạo thông báo trong transaction + đẩy sau commit**
  - Việc: `NotificationsService.createInTx(tx, …)` (`ON CONFLICT DO NOTHING`) + gom "việc sau commit"; gắn vào thêm thành viên kênh, chuyển chủ kênh, duyệt yêu cầu vào tổ chức.
  - Test: thao tác qua HTTP → đúng dòng thông báo + client socket nhận `notification.created`; thao tác lỗi (rollback) → không có thông báo, không có event; gọi lại không trùng.
- [ ] **B3 — API**
  - Việc: danh sách (cursor `created_at DESC, id DESC`, `orgId`, `unreadOnly`), đếm chưa đọc (Q5), đọc / đọc hết / xoá mềm; ẩn theo tổ chức (Q3).
  - Test (e2e): phân trang trùng `created_at`; thông báo người khác → 404; rời tổ chức → thông báo tổ chức đó biến mất; 150 chưa đọc → `"99+"`.
- [ ] **B4 — Đồng bộ "đã đọc" qua realtime**
  - Test: hai socket (hai phiên) của cùng người; đọc ở phiên A → phiên B nhận `notification.read`.
- [ ] **B5 — Fan-out "meeting được chia sẻ" bằng worker (processor đầu tiên)**
  - Việc: share commit → enqueue `notification.fanout.<dedupe>`; processor kiểm lại (meeting còn trong kênh?), lấy thành viên kênh (trừ người share, khách), INSERT theo lô 500, đẩy realtime sau mỗi lô.
  - Test (Redis thật, worker trong test): share → thành viên nhận, khách / người share không nhận; job chạy 2 lần → không trùng; gỡ share trước khi job chạy → không ai nhận; lỗi giữa chừng → retry không trùng. Đột biến bỏ `ON CONFLICT` / bỏ kiểm lại → đỏ.
- [ ] **B6 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu, chạy tay trên Compose (api + worker), ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI
- [ ] Không thông báo trùng, không thông báo "ma"; fan-out idempotent
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Hai đường tạo thông báo: trong transaction (ít người nhận) vs job fan-out (nhiều người nhận) — đánh đổi độ trễ / độ dài transaction
- Idempotency bằng khoá tự nhiên (`dedupe_key` + partial unique) cho job chạy lại
- BullMQ processor thật trong worker: đăng ký đúng chỗ, idempotent, kiểm lại trạng thái lúc chạy, retry
- Đếm có trần (`LIMIT` trong subquery) và index partial

## Điều học được / bẫy gặp phải

1. **Q3 hiện thực bằng FK cascade thay vì JOIN mỗi lần đọc.** FK composite `(org_id, user_id)` → `organization_members` ON DELETE CASCADE: rời / bị gỡ khỏi tổ chức → thông báo của tổ chức đó bị xoá theo; `org_id` NULL thì FK không áp (MATCH SIMPLE) nên thông báo ngoài tổ chức vẫn còn. Với người dùng giống "ẩn"; khác biệt duy nhất: quay lại tổ chức thì thông báo cũ không hiện lại. Truy vấn danh sách / đếm không phải JOIN. FK còn chặn luôn bug "tạo thông báo tổ chức cho người không thuộc tổ chức" (23503).
2. **Suýt lặp lại M5 bài học 2.** Cả ba index bắt đầu bằng `user_id` lúc đầu đều partial → FK `user_id` không có index dùng được (xoá user = quét bảng). Bỏ partial ở index danh sách để một index phục vụ cả hai việc; migration chưa commit → xoá và sinh lại cho sạch. Kiểm index partial "dùng được không" bằng `SET LOCAL enable_seqscan = off` + `EXPLAIN` (ít dòng thì planner luôn seq scan — không nói lên gì).
