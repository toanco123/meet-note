# M10 — Thông báo

- **Trạng thái:** **Xong** (2026-10-21): B1–B6, PR #8, CI xanh. Plan đã duyệt 2026-10-21 (★ cho Q1–Q6 — chưa cần Firebase)
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
- Processor chỉ đăng ký trong `WorkerModule`; tách `NotificationsCoreModule` (repository + service) dùng chung api + worker. _(B5: processor là `DefaultQueueProcessor` chung cho queue `default` ở `src/worker/`, không phải `NotificationsWorkerModule` — xem bài học 7.)_

## Thay đổi thiết kế

- Bảng `notifications` như 03 §6: thêm CHECK `type`, FK `user_id` ON DELETE CASCADE, index đúng như 03 (+ tên constraint).
- 05-api Notifications: chốt tham số + response; Realtime: `notification.created`, `notification.read`.

## Các bước

- [x] **B1 — Schema + migration**
  - Test (integration): unique partial `(user_id, dedupe_key)` (NULL không đụng nhau), CHECK `type`, EXPLAIN đếm chưa đọc dùng index partial.
- [x] **B2 — Tạo thông báo trong transaction + đẩy sau commit**
  - Việc: `NotificationsService.createInTx(tx, …)` (`ON CONFLICT DO NOTHING`) + gom "việc sau commit"; gắn vào thêm thành viên kênh, chuyển chủ kênh, duyệt yêu cầu vào tổ chức.
  - Test: thao tác qua HTTP → đúng dòng thông báo + client socket nhận `notification.created`; thao tác lỗi (rollback) → không có thông báo, không có event; gọi lại không trùng.
- [x] **B3 — API**
  - Việc: danh sách (cursor `created_at DESC, id DESC`, `orgId`, `unreadOnly`), đếm chưa đọc (Q5), đọc / đọc hết / xoá mềm; ẩn theo tổ chức (Q3).
  - Test (e2e): phân trang trùng `created_at`; thông báo người khác → 404; rời tổ chức → thông báo tổ chức đó biến mất; 150 chưa đọc → `"99+"`.
- [x] **B4 — Đồng bộ "đã đọc" qua realtime**
  - Test: hai socket (hai phiên) của cùng người; đọc ở phiên A → phiên B nhận `notification.read`.
- [x] **B5 — Fan-out "meeting được chia sẻ" bằng worker (processor đầu tiên)**
  - Việc: share commit → enqueue `notification.fanout.<dedupe>`; processor kiểm lại (meeting còn trong kênh?), lấy thành viên kênh (trừ người share, khách), INSERT theo lô 500, đẩy realtime sau mỗi lô.
  - Test (Redis thật, worker trong test): share → thành viên nhận, khách / người share không nhận; job chạy 2 lần → không trùng; gỡ share trước khi job chạy → không ai nhận; lỗi giữa chừng → retry không trùng. Đột biến bỏ `ON CONFLICT` / bỏ kiểm lại → đỏ.
- [x] **B6 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu, chạy tay trên Compose (api + worker), ghi "Điều học được".

## Tiêu chí hoàn thành

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh (391 unit)
- [x] `pnpm test:e2e` xanh ở local và CI (544 test; CI trên PR #8)
- [x] Không thông báo trùng, không thông báo "ma"; fan-out idempotent
- [x] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Hai đường tạo thông báo: trong transaction (ít người nhận) vs job fan-out (nhiều người nhận) — đánh đổi độ trễ / độ dài transaction
- Idempotency bằng khoá tự nhiên (`dedupe_key` + partial unique) cho job chạy lại
- BullMQ processor thật trong worker: đăng ký đúng chỗ, idempotent, kiểm lại trạng thái lúc chạy, retry
- Đếm có trần (`LIMIT` trong subquery) và index partial

## Điều học được / bẫy gặp phải

1. **Q3 hiện thực bằng FK cascade thay vì JOIN mỗi lần đọc.** FK composite `(org_id, user_id)` → `organization_members` ON DELETE CASCADE: rời / bị gỡ khỏi tổ chức → thông báo của tổ chức đó bị xoá theo; `org_id` NULL thì FK không áp (MATCH SIMPLE) nên thông báo ngoài tổ chức vẫn còn. Với người dùng giống "ẩn"; khác biệt duy nhất: quay lại tổ chức thì thông báo cũ không hiện lại. Truy vấn danh sách / đếm không phải JOIN. FK còn chặn luôn bug "tạo thông báo tổ chức cho người không thuộc tổ chức" (23503).
2. **Suýt lặp lại M5 bài học 2.** Cả ba index bắt đầu bằng `user_id` lúc đầu đều partial → FK `user_id` không có index dùng được (xoá user = quét bảng). Bỏ partial ở index danh sách để một index phục vụ cả hai việc; migration chưa commit → xoá và sinh lại cho sạch. Kiểm index partial "dùng được không" bằng `SET LOCAL enable_seqscan = off` + `EXPLAIN` (ít dòng thì planner luôn seq scan — không nói lên gì).
3. **Payload có kiểu theo từng loại** (`NotificationPayloads` + union `NotificationDraft`): tạo thông báo thiếu trường hay ghép nhầm payload của loại khác là lỗi compile. Người nhận "chuyển chủ kênh" = chủ mới + chủ cũ trừ người thực hiện — đột biến không loại người thực hiện → đỏ. "Đẩy sau commit" kiểm bằng spy trên publisher thật của app: lúc `emit`, connection khác đã thấy dòng; đột biến gọi `publish` trong transaction → đỏ.
4. **Lỗi 500 chập chờn ở hạ tầng test (đang theo dõi, chưa sửa).** Một lượt chạy nhóm `integration + e2e/channels + e2e/invites` hỏng ở `beforeAll` của `join-requests.e2e-spec` (chấp nhận link mời — luồng M10 không đụng): 500 sau **5 341 ms**, khớp `connectionTimeoutMillis: 5000` của pool app. Không tái hiện được (6 lượt sau đó, 4 lượt có log `error`). Giả thuyết: nhiều file chạy song song, mỗi file pool riêng (có file tới 40 connection) trong khi Postgres container mặc định `max_connections = 100` → lấy connection bị nghẽn. Theo M5 bài học 21: chưa có stack thì không sửa theo đoán; nếu gặp lại, log đầy đủ sẽ cho biết đúng lỗi.
5. **API "đọc / xoá" idempotent bằng một câu UPDATE `coalesce`**: `read_at = coalesce(read_at, now())` — đọc lại không đổi mốc đọc lần đầu, và 0 dòng trả về nghĩa là "không có / của người khác" → 404 mà không cần SELECT trước. Đếm chưa đọc có trần bằng `LIMIT` trong subquery. 4 đột biến (bỏ điều kiện chủ thông báo, bỏ trần, bỏ `coalesce`, bỏ tie-breaker cursor) đều đỏ — phân trang test với `limit 7` trên nhóm 5 dòng trùng `created_at` (M6b bài học 4).
6. **Kiểm "KHÔNG phát" bằng thứ tự, không bằng chờ timeout.** Event từ cùng một publisher tới cùng socket đi qua một kênh Redis nên giữ thứ tự: làm thao tác không được phát (đọc hết khi không còn gì, đọc của người khác → 404) rồi một thao tác CÓ phát — event kế tiếp phiên B nhận phải là của thao tác sau. Chờ "3 giây không thấy gì" vừa chậm vừa không chứng minh được gì. Tương tự, `204` chưa có nghĩa event đã tới socket: muốn khẳng định socket người khác không nhận nhầm thì chờ event của chính họ rồi mới đếm. 3 đột biến (bỏ phát khi đọc một, phát cả khi đọc hết 0 dòng, phát trước khi kiểm 404) đều đỏ. Đọc hết gửi `{ all, orgId }` thay vì danh sách id — `markAllRead` trả `rowCount`, không `RETURNING` hàng chục nghìn id chỉ để biết "có đổi không".
7. **Một processor cho mỗi queue, không phải mỗi domain.** Plan ghi `NotificationsWorkerModule` chứa processor riêng; nhưng BullMQ Worker **không lọc job theo tên** — hai `@Processor('default')` cùng chạy sẽ giành job của nhau, bên nhận tên lạ làm hỏng job. Nên chỉ có `DefaultQueueProcessor` (`src/worker/`) `switch (job.name)` → service của `NotificationsCoreModule`. Kéo theo một bẫy: `meeting.preprocess` (M5 đã enqueue, M6 hoãn) giờ có người nhận; ném lỗi thì job thành `failed` và jobId cũ chặn enqueue lại → **cất** bằng `job.moveToDelayed(now + 1h, token)` + `throw new DelayedError()`: job về `delayed`, `attemptsMade` vẫn 0 (e2e kiểm). Tên job lạ → `UnrecoverableError` → `failed` ngay dù `attempts: 3`.
8. **Cô lập queue giữa các file test** như M7 bài học 12 với Socket.IO: mọi file e2e dùng chung container Redis, prefix `meetnote` cố định → worker của file này lấy job của file khác (DB khác). Thêm env `QUEUE_PREFIX`, `setup-e2e` đặt ngẫu nhiên mỗi file. Worker trong test dựng bằng `createTestWorker()` (`Test.createTestingModule({ imports: [WorkerModule] })` + `init()`), chờ kết quả bằng `job.waitUntilFinished(queueEvents)`.
9. **Fan-out idempotent không cần transaction bao ngoài.** Mỗi lô là một INSERT `ON CONFLICT DO NOTHING RETURNING` → chỉ đẩy realtime cho dòng VỪA tạo; lỗi ở lô 2 thì lô 1 giữ nguyên, lần retry chỉ bù phần thiếu (integration test giả lập lỗi ở lần `insertMany` thứ 2). Người nhận lấy theo keyset `user_id` trên PK `(channel_id, user_id)`; MỖI lô kiểm lại "share còn sống" (`EXISTS` share + meeting / kênh chưa xoá) nên gỡ share giữa chừng → các lô sau rỗng. 5 đột biến (bỏ kiểm meeting đã xoá, bỏ `ON CONFLICT`, không loại khách, không loại người share, `meeting.preprocess` ném lỗi thay vì cất) đều đỏ. Đột biến **lọt**: keyset `gt` → `gte` — vô hại (người cuối lô bị chọn lại, `ON CONFLICT` nuốt), chỉ tốn một dòng mỗi lô.
10. **jobId có mốc share** (`….{sharedAt ms}`): share → gỡ → share lại trong 24 h (job cũ còn được giữ) vẫn ra job mới, người mới vào kênh được báo; người đã nhận thì `dedupe_key` chặn. Share lặp lại (200, cùng dòng) vẫn enqueue với cùng jobId → nếu lần enqueue trước lỗi (Redis sập sau commit) thì gọi lại share là đủ để bù — "outbox nghèo" như M5.
11. **Chạy tay trên Compose (B6).** `docker compose up -d --build migrate api worker`, script smoke chạy TRONG container api (`docker compose exec -T api node --input-type=module -`) — cổng 3000 của máy đang bị một dev server khác chiếm, gọi từ trong container thì không phụ thuộc cổng máy. Kết quả: share 201 → member thấy `meeting.shared` qua `GET /notifications` sau ~115 ms (payload đủ tên), share lại 200 không sinh thêm; chủ kênh 1, member 1, khách 0, người share 0; unread member = 2 (`channel.member_added` + `meeting.shared`). Redis dev: 2 job `meeting.preprocess` cũ của M5 nằm ở `delayed` (được cất, không `failed`), 1 job fan-out `completed`. `openapi.json` đổi 354 dòng dù không đổi API: chỉ đổi THỨ TỰ path (module khác import `NotificationsCoreModule` → Nest quét `NotificationsModule` muộn hơn); `jq -S` hai bản giống hệt.
