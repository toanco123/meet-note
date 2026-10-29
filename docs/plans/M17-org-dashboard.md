# M17 — Dashboard tổ chức

- **Trạng thái:** Đang làm
- **Nhánh:** `m17-dashboard`
- **Tài liệu thiết kế liên quan:** `docs/design/01-overview.md` (D2: quản trị ≠ đọc nội dung), `03-database.md` (§ meeting, RLS), `04-authorization.md`, `05-api.md`, `06-flows.md`, `10-roadmap.md` (M17). Plan M9 (cron + múi giờ VN, `REPORT_TIME_ZONE`), M12 (`action_items`), M11 (RLS)

## Mục tiêu

Owner / Admin xem **số liệu tổng hợp** của tổ chức trong một khoảng ngày: bao nhiêu cuộc họp, bao nhiêu phút họp / phút đã transcribe, tỉ lệ pipeline lỗi, thành viên hoạt động, dung lượng lưu trữ, kênh hoạt động nhiều nhất, và (nhờ M12) số việc đang mở / quá hạn. **Chỉ trả số**, không trả tiêu đề meeting, nội dung, tên việc (D2). Số theo ngày đến từ **bảng rollup** do worker cập nhật.

Điểm khó của mốc: (1) rollup phải **idempotent** và **đúng khi dữ liệu nguồn đổi** (xoá meeting, sửa `recorded_at`, pipeline xong muộn); (2) cắt ngày theo múi giờ VN; (3) có con số **cộng được** (đếm) và con số **không cộng được** (người hoạt động phân biệt) — chỉ cái đầu đưa vào rollup; (4) số tổng hợp cũng là dữ liệu cần phân quyền.

## Hiện trạng (không làm lại)

- Cột nguồn có sẵn: `meetings.recorded_at`, `duration_ms`, `status`, `failure_code`, `owner_id`, `deleted_at` (xoá mềm); `uploads.size_bytes` + `meeting_id`; `meeting_shares` (meeting ↔ kênh); `action_items` (M12).
- Cron có múi giờ + fan-out + job idempotent: mẫu M9 (`report-tick`). Ngày VN: `REPORT_TIME_ZONE` / `localDate` / `addDays` ở `src/modules/reports/report-week.ts`.
- **Tổ chức chưa có cột múi giờ** — "cắt theo múi giờ tổ chức" ở roadmap hiện nghĩa là giờ VN cố định như báo cáo tuần (Q2).
- Không có "lần cuối hoạt động" của người dùng theo thời gian (`sessions.last_used_at` chỉ giữ lần mới nhất, không truy vấn theo khoảng được) → "thành viên hoạt động" phải định nghĩa từ dữ liệu có thật (Q4).

## Ngoài phạm vi của mốc này

- Số liệu theo từng người (bảng xếp hạng, ai họp nhiều nhất): thành ra giám sát cá nhân; chỉ có số tổng và top **kênh**
- Múi giờ riêng từng tổ chức (cần cột + UI đổi múi giờ + dựng lại rollup)
- Chi phí / token LLM, thời gian xử lý pipeline, biểu đồ realtime, cache HTTP, xuất CSV
- Dashboard cho Member hoặc theo từng kênh (quyền kênh khác hẳn)

## Quyết định cần duyệt (★ = đề xuất)

| #   | Câu hỏi                              | Lựa chọn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Rollup hay đếm trực tiếp?            | ★ **Bảng `org_daily_stats`** (một dòng / org / ngày VN) chỉ chứa số **cộng được**; worker tính lại **cả ngày** bằng một câu `INSERT … SELECT … ON CONFLICT DO UPDATE` từ bảng nguồn (idempotent theo thiết kế: chạy lại cho cùng kết quả, không có bộ đếm tăng dần để đếm trùng). Thay thế: đếm trực tiếp trên `meetings` mỗi lần gọi — ở quy mô này vẫn đủ nhanh nhờ `meetings_org_recorded_idx`, và đơn giản hơn nhiều. Chọn rollup **vì mục tiêu học** (roadmap), không vì cần hiệu năng hôm nay; ghi thẳng điều đó vào tài liệu                        |
| Q2  | Cắt ngày theo múi giờ nào?           | ★ `Asia/Ho_Chi_Minh` cố định, dùng lại `REPORT_TIME_ZONE`; một cuộc họp thuộc ngày VN của `recorded_at` (biên 16:59:59Z / 17:00:00Z có test). Thay thế: thêm cột múi giờ vào `organizations` — để mốc sau                                                                                                                                                                                                                                                                                                                                                  |
| Q3  | Con số nào vào rollup?               | ★ Theo ngày họp (`recorded_at`, meeting chưa xoá): `meetings_total`, `meetings_completed`, `meetings_failed`, `recorded_ms` (tổng `duration_ms` mọi meeting đã biết thời lượng), `transcribed_ms` (tổng `duration_ms` meeting `completed`). Tỉ lệ lỗi = `failed / (completed + failed)` (chỉ tính meeting đã kết thúc; đang xử lý không làm tỉ lệ nhảy). Xoá meeting → biến khỏi mọi số                                                                                                                                                                    |
| Q4  | Con số không cộng được tính ở đâu?   | ★ **Tính trực tiếp** khi gọi API (không vào rollup, vì "người phân biệt" của 7 ngày ≠ tổng 7 con số hằng ngày): thành viên hoạt động = số chủ meeting phân biệt có meeting họp trong khoảng (không có dữ liệu "đăng nhập theo thời gian" — nêu rõ hạn chế), tổng thành viên, **dung lượng** = tổng `uploads.size_bytes` của meeting chưa xoá (số hiện tại, không phải chuỗi thời gian), **top 5 kênh** theo số meeting được share trong khoảng, **việc cần làm**: số `open`, số quá hạn (hạn trước hôm nay VN), số `done` có `completed_at` trong khoảng   |
| Q5  | Khi nào rollup được tính lại?        | ★ Ba đường, cùng một hàm `rollupDay(orgId, day)`: (a) cron mỗi 5 phút tính lại **hôm nay và hôm qua** của mọi tổ chức có meeting đổi trong 10 phút qua (`updated_at`); (b) **theo sự kiện** sau commit khi xoá meeting hoặc sửa `recorded_at` (job cho ngày cũ **và** ngày mới — nếu không, ngày cũ giữ số sai mãi); (c) job đêm 03:00 tính lại 35 ngày gần nhất làm lưới an toàn. Số "hôm nay" có thể trễ tới 5 phút — ghi vào tài liệu và `computedAt` trong response. Thay thế: chỉ (a)+(c) — đơn giản hơn nhưng xoá meeting cũ chỉ giảm số sau một đêm |
| Q6  | Tính lại đồng thời cùng (org, ngày)? | ★ Bọc trong `pg_advisory_xact_lock(hash(org, ngày))`: không có khoá thì A đọc nguồn lúc t1, B đọc lúc t2 > t1 và ghi trước, rồi A ghi **đè số cũ** lên số mới. Có test hai lần tính song song sau khi sửa nguồn (đột biến bỏ khoá phải đỏ)                                                                                                                                                                                                                                                                                                                 |
| Q7  | Quyền & riêng tư                     | ★ Quyền mới `org.dashboard.read` = Owner / Admin (Member → 403, người ngoài org → 404 do `OrgMemberGuard`). Response chỉ có số + **tên và id kênh** ở top kênh (Owner / Admin đã thấy metadata mọi kênh theo D2, kể cả kênh riêng tư; không có tiêu đề meeting, không có tên người, không có chữ của việc). Test khẳng định JSON không chứa tiêu đề meeting / nội dung việc đã dựng trong fixture. Thay thế: ẩn kênh riêng tư khỏi top — an toàn hơn nhưng lệch D2                                                                                         |
| Q8  | Hình dạng API                        | ★ `GET /orgs/:orgId/dashboard?from=&to=&granularity=day\|week`. `from`/`to` là ngày VN `YYYY-MM-DD` bao gồm hai đầu; mặc định 30 ngày gần nhất tới hôm nay; `from > to` hoặc khoảng > 92 ngày → 400. `series` được **điền đủ ngày 0** (không bỏ ngày trống); `granularity=week` gom theo tuần bắt đầu Thứ Hai (cùng quy ước báo cáo tuần). Số liệu lưu trữ / thành viên / việc là số của **thời điểm gọi** (các trường này không đổi theo `granularity`)                                                                                                   |
| Q9  | RLS                                  | ★ `org_daily_stats` có `org_id` + policy `org_id = app_current_org_id()` cùng mẫu M11/M12 (api đọc dưới ngữ cảnh org; worker BYPASSRLS ghi)                                                                                                                                                                                                                                                                                                                                                                                                                |

## Thay đổi thiết kế

- **Bảng mới `org_daily_stats`** (migration `0019`, RLS viết tay): `org_id` FK `organizations` CASCADE, `day date`, `meetings_total`, `meetings_completed`, `meetings_failed` `int`, `recorded_ms`, `transcribed_ms` `bigint`, `computed_at timestamptz`; `PRIMARY KEY (org_id, day)`; CHECK mọi số ≥ 0 và `completed + failed <= total`.
- **Job:** `stats.rollup` `{ orgId, day }` (queue `default`), jobId `stats.rollup.<orgId>.<day>.<lần>` (theo skill `bullmq-jobs`, không dấu `:`); tick `stats.tick` mỗi 5 phút, `stats.reconcile` 03:00 giờ VN. Processor chỉ đăng ký trong `WorkerModule`.
- **API mới:** `GET /orgs/:orgId/dashboard` (tag `Dashboard`).
- **Quyền mới:** `org.dashboard.read` trong `organization.policy.ts` + ma trận ở 04.
- **Dependency mới:** không.

## Các bước

- [ ] **B1 — Schema + câu tính lại một ngày**
  - Việc: bảng `org_daily_stats` + migration `0019` (đọc SQL sinh ra, thêm RLS bằng tay); repository `rollupDay(orgId, day)` bằng MỘT câu `INSERT … SELECT … ON CONFLICT DO UPDATE` (biên ngày VN tính bằng `(day)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'` như `meetingsForWeek`); `readRange(orgId, from, to)`; sửa 03.
  - Test (integration): từng CHECK; biên 16:59:59.999Z / 17:00:00Z; đếm đúng theo trạng thái, meeting đang xử lý không vào `completed`/`failed`; meeting đã xoá bị loại; **chạy hai lần cho cùng kết quả**; sửa nguồn rồi tính lại → số đổi theo; ngày không còn meeting → dòng về 0 (không để số cũ); org khác không lẫn; RLS (api không thấy org khác).
- [ ] **B2 — Job rollup + tick + sự kiện + đêm**
  - Việc: `StatsRollupService` (khoá advisory theo (org, ngày) — Q6), processor, tick 5 phút tìm (org, ngày) có meeting đổi, job theo sự kiện khi xoá meeting / sửa `recorded_at` (enqueue SAU commit, ngày cũ và mới), job đêm; sửa 06.
  - Test: hai `rollupDay` song song sau khi sửa nguồn → kết quả cuối khớp nguồn (đột biến bỏ khoá advisory → đỏ); xoá meeting cũ → job tính lại đúng ngày của nó; sửa `recorded_at` sang ngày khác → cả hai ngày đúng; tick chỉ chọn org có thay đổi; payload chỉ ID, jobId không có `:`.
- [ ] **B3 — Số liệu tính trực tiếp**
  - Việc: repository thành viên hoạt động / tổng, dung lượng, top 5 kênh, số việc (open / overdue / done trong khoảng).
  - Test (integration): bảng kỳ vọng dựng tay cho từng số; meeting đã xoá không tính dung lượng / thành viên hoạt động; kênh đã xoá không vào top; người rời org; hạn "hôm nay" chưa quá hạn (cùng quy ước M12); org khác không lẫn.
- [ ] **B4 — Service + quyền**
  - Việc: `DashboardService` (validate khoảng, điền đủ ngày, gom tuần Thứ Hai, tính tỉ lệ lỗi, `computedAt`), quyền `org.dashboard.read`; sửa 04.
  - Test (unit): bảng khoảng ngày (1 ngày, 92 / 93 ngày, `from > to`, qua năm, biên tuần), điền ngày trống, gom tuần, tỉ lệ lỗi khi mẫu = 0 (không chia cho 0), ma trận quyền Owner / Admin / Member.
- [ ] **B5 — Controller + DTO + e2e + Swagger**
  - Việc: route, DTO (`*ResponseDto`, JSDoc), `@ApiErrorResponses(400, 403)`, `RateLimit` nếu cần, `openapi.json`; sửa 05.
  - Test (e2e): Owner / Admin 200, Member 403, người ngoài 404; **JSON không chứa tiêu đề meeting / tên việc / tên người** đã dựng trong fixture; xoá meeting rồi (gọi rollup) số giảm đúng; đầu vào sai → 400; tuần vs ngày cho cùng tổng.
- [ ] **B6 — Tài liệu + đóng mốc**
  - Việc: 02 (module), 03, 04, 05, 06, 07 nếu có mã lỗi mới; README + CLAUDE.md (hàng M17); bài học; `pnpm build && pnpm openapi:export`; chạy đủ `test:e2e`.

Mỗi bước kèm **đột biến** cho phần có logic (bỏ lọc `deleted_at`, `completed` ↔ `failed` lẫn, bỏ khoá advisory, biên ngày lệch UTC, bỏ điền ngày trống, bỏ kiểm quyền…) như M12.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở CI
- [ ] Admin xem số liệu 30 ngày; Member gọi bị 403; người ngoài 404
- [ ] Xoá meeting (kể cả meeting cũ) rồi rollup → số giảm đúng; sửa `recorded_at` → cả hai ngày đúng
- [ ] Rollup chạy lại / chạy song song không đếm trùng, không để số cũ ghi đè số mới (có đột biến)
- [ ] Response không chứa tiêu đề / nội dung / tên người (có test)
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Bảng rollup vs đếm trực tiếp: độ tươi dữ liệu đổi lấy chi phí, và khi nào rollup **không** đáng
- Rollup idempotent bằng cách **tính lại từ nguồn** thay vì cộng dồn; khoá advisory chống ghi đè số cũ lên số mới
- Số cộng được vs không cộng được (đếm phân biệt)
- Cắt ngày theo múi giờ trong SQL; biên ngày; dữ liệu nguồn đổi làm ngày cũ sai (sửa `recorded_at`)
- Số tổng hợp cũng cần phân quyền và kiểm tra rò rỉ

## Điều học được / bẫy gặp phải

(Ghi sau khi xong mốc)
