# M9 — Báo cáo tuần

- **Trạng thái:** Đang làm — plan đã duyệt 2026-10-26 (★ cho Q1–Q10)
- **Nhánh:** `m9-weekly-reports`
- **Tài liệu thiết kế liên quan:** [10-roadmap M9](../design/10-roadmap.md), [01-overview D6, D8](../design/01-overview.md), [03-database §5](../design/03-database.md), [04-authorization (ma trận kênh)](../design/04-authorization.md), [05-api Reports](../design/05-api.md), [06-flows §2](../design/06-flows.md)
- **Mốc trước:** M8 đã xong (PR #11) — tiêu chí đều tick; phần chưa kiểm tay (whisper thật, Claude thật) vẫn ghi ở bài học 20 của M6.

## Mục tiêu

Mỗi sáng thứ Hai 08:00 (giờ Việt Nam) hệ thống tự tạo báo cáo của **tuần trước** cho từng kênh có ≥ 2 cuộc họp xong: tổng hợp từ tóm tắt các meeting, có phiên bản, thành viên kênh nhận thông báo `report.ready`. Quản trị kênh tạo lại được tối đa 3 lần. Kích hoạt tick thủ công (backfill) ra báo cáo cho tuần bất kỳ.

## Đã có từ các mốc trước (không làm lại)

- Cột `channels.weekly_report_enabled` (M4) + `PATCH …/channels/:id { weeklyReportEnabled }` (bật/tắt).
- `meeting_summaries.content` (M6): đầu vào của báo cáo. Hạ tầng LLM (`Summarizer`, Fake/Anthropic, phân loại lỗi tạm/vĩnh viễn, map-reduce).
- Job Scheduler + `WorkerSchedules` + `MaintenanceJobRunner` (M6 B8); lease + fencing token (M6 B4); `NotificationFanoutService` + `dedupe_key` (M10).
- RLS theo `org_id` (M11), `channel.content.read` (xem được kênh).

## Ngoài phạm vi

- Báo cáo theo tháng / theo khoảng tuỳ chọn; báo cáo cấp tổ chức (M17 dashboard).
- Mục "việc quá hạn" trong báo cáo (M12 — cần action items có trạng thái).
- Gửi email / webhook khi báo cáo xong (M14).
- Tuỳ chỉnh giờ chạy / múi giờ theo kênh hoặc tổ chức (cố định `Asia/Ho_Chi_Minh`, D8).
- Sửa tay nội dung báo cáo.

## Quyết định cần duyệt (★ = đề xuất)

| #   | Câu hỏi                                              | Phương án                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Sinh nội dung báo cáo bằng gì?                       | ★ Interface mới **`ReportWriter`** (cạnh `Summarizer`, có Fake + Anthropic), đầu vào là **tóm tắt của các meeting** (không phải transcript) → đầu ra có cấu trúc `{ overview, highlights[], decisions[], actionItems[], meetings[{id,title}] }`, validate lại ở server như M6. Dùng chung `LLM_PROVIDER` / model / effort; tái dùng client + phân loại lỗi của `AnthropicSummarizer`. Phương án khác: nhét vào `Summarizer` (một interface làm hai việc, input khác hẳn)             |
| Q2  | Chọn meeting vào báo cáo thế nào?                    | ★ D8: meeting `completed`, còn **đang được share** vào kênh (kênh chưa xoá, share còn, meeting chưa xoá), `recorded_at` thuộc `[weekStart 00:00, +7 ngày)` **giờ VN**. Khoảng thời gian tính bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'` (không `date_trunc('week', now())` — phụ thuộc timezone session). **Chụp lại `meeting_ids`** trong từng phiên bản: nội dung báo cáo cũ không đổi khi meeting bị gỡ share sau đó, và tạo lại thì tính lại từ đầu                                  |
| Q3  | Tick tạo báo cáo cho kênh thế nào?                   | ★ Tick chỉ fan-out (không gọi LLM): duyệt kênh bật báo cáo, chưa xoá, **chưa lưu trữ** (lưu trữ = chỉ đọc) theo lô keyset; `INSERT … ON CONFLICT (channel_id, week_start) DO NOTHING`; rồi enqueue `weekly-report.generate` cho **mọi dòng `pending` của tuần đó** (kể cả dòng tick trước đã chèn mà chết trước khi enqueue — bài học M6 B8: đừng chỉ enqueue dòng vừa chèn). `weekStart` suy từ `firedAt` của tick (không từ `now()` lúc xử lý) nên tick xử lý trễ vẫn ra đúng tuần |
| Q4  | Máy trạng thái của một báo cáo?                      | ★ **Lease + fencing token** như M6 B4, KHÔNG phải `UPDATE … WHERE status IN (pending, failed)` như 06 §2 hiện viết: retry của BullMQ thấy `generating` → bỏ qua → kẹt mãi (đúng bài học 9 của M6). Thêm `generation_token`, `lease_until`. Sửa 06 §2 trong cùng mốc                                                                                                                                                                                                                  |
| Q5  | Báo cáo đang tạo lại thì người xem thấy gì?          | ★ Vẫn thấy **phiên bản hiện tại** (`current_version`) cho tới khi phiên bản mới xong; `status` báo `generating`. Tạo lại LỖI không làm mất bản cũ (`status=failed`, `last_error`, `current_version` giữ nguyên, không tính vào quota — 06 §2). Phương án khác: ẩn nội dung lúc đang tạo lại (người dùng thấy trang trống vì một lần bấm)                                                                                                                                             |
| Q6  | Tạo lại thủ công có tính cả báo cáo `skipped` không? | ★ **Có** — `skipped` (< 2 meeting) có thể thành đủ 2 khi meeting xong muộn; tạo lại tính lại danh sách từ đầu. Vẫn trừ quota (3 lần / báo cáo). Quyền: **CO, CA** (04 dòng 52; Org Owner/Admin không ở trong kênh thì ✗)                                                                                                                                                                                                                                                             |
| Q7  | Ai nhận thông báo `report.ready`?                    | ★ Báo cáo **theo lịch**: mọi thành viên kênh trừ Khách (04 dòng 53), `dedupe_key = report:{id}:v{n}`. Báo cáo **tạo lại thủ công**: chỉ người bấm (họ đang chờ; cả kênh nhận thêm 3 thông báo / tuần là ồn). **Lệch 06 §2** (ghi "thành viên kênh" cho mọi phiên bản) — nếu bạn muốn thông báo cả kênh mỗi lần thì đổi một dòng                                                                                                                                                      |
| Q8  | Lỡ lịch (Redis sập đúng 08:00) xử lý thế nào?        | ★ Hai lớp: (a) lệnh **`pnpm report:backfill --week 2026-10-05`** (script enqueue một tick có `weekStart` tường minh, idempotent nên chạy thừa an toàn) — thay cho "endpoint admin" trong 06 §2, vì dự án chưa có khái niệm quản trị hệ thống để gác một endpoint như vậy; (b) quét báo cáo kẹt trong job 5 phút có sẵn: `pending` không có job / `generating` hết lease → enqueue lại với jobId riêng `….r<version>` (cùng bài học M6 B8)                                            |
| Q9  | Bảng mới có RLS không?                               | ★ **Có** (quy tắc M11): `weekly_reports` và `weekly_report_versions` đều mang `org_id` + composite FK + policy `org_id = app_current_org_id()`. Worker (BYPASSRLS) đọc xuyên tổ chức khi tick                                                                                                                                                                                                                                                                                        |
| Q10 | Gửi tóm tắt meeting lên Claude API có cần duyệt lại? | Q2 của M6 đã đồng ý gửi **transcript**. Báo cáo gửi **tóm tắt** (đã rút gọn, ít nhạy cảm hơn) cùng `LLM_PROVIDER`. Mặc định vẫn `fake` — không gửi gì ra ngoài cho tới khi bạn bật `anthropic`                                                                                                                                                                                                                                                                                       |

## Thay đổi thiết kế

- **Bảng (sửa 03 §5):** `weekly_reports` (thêm `generation_token`, `lease_until`, `org_id`, `status` CHECK, `regenerate_count` CHECK 0–3, `UNIQUE (channel_id, week_start)`, composite FK `(channel_id, org_id)`, RLS), `weekly_report_versions` (`UNIQUE (report_id, version)`, `meeting_ids uuid[]`, `content jsonb`, `trigger`, `triggered_by`, `model`, `prompt_version`, token, RLS). CHECK `notifications.type` thêm `report.ready`.
- **Index:** `weekly_reports (week_start, status)` cho tick / sweep; `weekly_reports (channel_id, week_start DESC)` cho danh sách (UNIQUE đã phủ phần lớn).
- **API (05 §Reports):** `GET /channels/:channelId/reports?cursor=` (mới nhất trước), `GET …/:weekStart` (bản hiện tại + `status`), `GET …/:weekStart/versions`, `POST …/:weekStart/regenerate` → 202. `weekStart` phải là Thứ Hai (không phải → 400).
- **Quyền:** thêm `channel.report.regenerate` (CO, CA) vào policy kênh + ma trận 04 đã có sẵn dòng; xem báo cáo = `channel.content.read`.
- **Lỗi mới:** `REPORT_NOT_FOUND` (404), `REPORT_IN_PROGRESS` (409), `REPORT_REGENERATE_LIMIT` (409).
- **Env:** không thêm (`WORKER_SCHEDULES_ENABLED`, `LLM_*` đã có).
- **Dependency mới:** không.

## Các bước

- [ ] **B1 — Schema + migration + RLS (integration)**
  - Việc: hai bảng, CHECK, composite FK, RLS viết tay (mẫu 0012/0013), `notifications_type_ck` thêm `report.ready`; sửa 03 §5.
  - Test: UNIQUE `(channel_id, week_start)` (`23505` đúng tên constraint); `regenerate_count` 4 → `23514`; user api thấy 0 dòng của org khác, worker thấy cả hai; xoá kênh cascade; không FK chéo org.
- [ ] **B2 — Tính tuần + chọn meeting (hàm thuần + integration)**
  - Việc: `weekStartOf(firedAt)` / `weekRange(weekStart)` theo giờ VN (Intl, không `now()` của DB); truy vấn meeting của kênh trong tuần (Q2), kèm summary.
  - Test: bảng giờ biên — CN 23:59:59,999 VN vs Thứ Hai 00:00 VN; `firedAt` UTC chủ nhật 17:00 (= thứ Hai 00:00 VN) thuộc tuần nào; tick trễ nhiều giờ; meeting `failed` / chưa xong / đã gỡ share / kênh khác / đã xoá bị loại; meeting share vào hai kênh vào cả hai báo cáo. Đột biến `date_trunc('week', now())` hoặc đổi `<` thành `<=` ở biên → đỏ.
- [ ] **B3 — `ReportWriter` (Fake + Anthropic) + validate**
  - Việc: interface, schema JSON đầu ra, validate lại ở server (sai schema = lỗi tạm), cắt số meeting đưa vào prompt (tối đa N, ghi `truncated` vào version nếu cắt), phân loại lỗi như `AnthropicSummarizer`.
  - Test (stub server, như B3 của M6): trả đúng / sai schema / 429 / 400; `FakeReportWriter` xác định.
- [ ] **B4 — Dịch vụ tạo báo cáo (lease + fencing)**
  - Việc: `claim` (lease + token), `< 2 meeting` → `skipped`, ngược lại gọi writer rồi **một transaction**: chèn version `n+1` + `current_version`, `status=completed`, nhả lease (kiểm token); lỗi tạm → nhả lease, ném để BullMQ retry; hết lượt → `failed` + `last_error`.
  - Test: chạy 2 lần cùng job → đúng 1 version; retry sau lỗi tạm đi tiếp được (không kẹt `generating`); worker chết (lease hết hạn) → job khác nhận; mất lease giữa chừng → không ghi. **Đột biến** bỏ kiểm token → ghi đè; bỏ `ON CONFLICT` của tick → trùng.
- [ ] **B5 — Tick + lịch + backfill**
  - Việc: cron `0 8 * * 1` tz VN trong `WorkerSchedules`; tick duyệt kênh theo lô keyset, chèn `ON CONFLICT DO NOTHING`, enqueue mọi dòng `pending` của tuần (Q3); processor cho `weekly-report.tick` / `.generate`; `pnpm report:backfill --week`.
  - Test (e2e, Redis thật): 3 kênh (2 đủ meeting, 1 thiếu, 1 tắt báo cáo, 1 lưu trữ) → báo cáo đúng; tick chạy 2 lần / 2 worker song song → không trùng; tick chết giữa chừng (đã chèn, chưa enqueue) → chạy lại vẫn enqueue đủ; một kênh lỗi không chặn kênh khác.
- [ ] **B6 — API đọc + tạo lại**
  - Việc: 4 route, DTO, policy `channel.report.regenerate`, 202; tạo lại = transaction `FOR UPDATE` → kiểm `generating` / quota → `count+1` → enqueue SAU commit với `jobId=…v{n}`.
  - Test (e2e): ma trận quyền dạng bảng (CO, CA ✓; CM, G, OrgAdm ✗; ngoài kênh riêng 404); `weekStart` không phải Thứ Hai → 400; **race:** 2 regenerate song song khi `count=2` → đúng một 202, `count=3` (đột biến bỏ `FOR UPDATE` → CHECK bắt → 500 thay 409, như 03 §5 đã cảnh báo); đang `generating` → 409; xem trong lúc tạo lại thấy bản cũ.
- [ ] **B7 — Thông báo `report.ready` + quét kẹt**
  - Việc: loại thông báo mới (fan-out thành viên kênh trừ Khách, dedupe `report:{id}:v{n}`; thủ công → chỉ người bấm, Q7); mở rộng job quét 5 phút cho báo cáo kẹt (Q8b).
  - Test: Khách không nhận; chạy fan-out 2 lần không nhân đôi; tạo lại → người bấm nhận, cả kênh không; báo cáo `pending` mất job → quét → xong; `generating` còn lease → quét để yên.
- [ ] **B8 — Tài liệu + openapi + đóng mốc**
  - Việc: sửa 03 §5, 04, 05, 06 §2 (lease thay `UPDATE WHERE status`, Q7, Q8), 07 (mã lỗi), 10; `pnpm build && pnpm openapi:export`; README / CLAUDE.md; bài học.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở CI (local cần ffmpeg cho 6 file pipeline — đã gỡ máy dev)
- [ ] Tick chạy trùng / song song / chết giữa chừng không tạo báo cáo hay job trùng (có đột biến)
- [ ] Biên tuần theo giờ VN đúng (test bảng giờ, có đột biến)
- [ ] Quota tạo lại chính xác dưới race (có đột biến bỏ `FOR UPDATE`)
- [ ] Retry / chết worker không để báo cáo kẹt `generating`
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Cron đa instance và múi giờ: `tz` của Job Scheduler, tính biên tuần độc lập timezone của DB, tick xử lý trễ vẫn đúng tuần
- Idempotency theo khoá tự nhiên (`UNIQUE` + `ON CONFLICT DO NOTHING`) và cái bẫy "chèn xong mà chưa enqueue"
- Máy trạng thái có phiên bản: bản cũ còn đọc được khi bản mới đang tạo / lỗi; quota bằng `FOR UPDATE` + CHECK
- Dùng lại lease + fencing token cho một loại việc mới, và quét kẹt tổng quát hoá

## Điều học được / bẫy gặp phải

(Ghi sau khi xong mốc)
