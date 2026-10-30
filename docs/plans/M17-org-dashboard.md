# M17 — Dashboard tổ chức

- **Trạng thái:** Xong (PR #15)
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

| #   | Câu hỏi                              | Lựa chọn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Rollup hay đếm trực tiếp?            | ★ **Bảng `org_daily_stats`** (một dòng / org / ngày VN) chỉ chứa số **cộng được**; worker tính lại **cả ngày** bằng một câu `INSERT … SELECT … ON CONFLICT DO UPDATE` từ bảng nguồn (idempotent theo thiết kế: chạy lại cho cùng kết quả, không có bộ đếm tăng dần để đếm trùng). Thay thế: đếm trực tiếp trên `meetings` mỗi lần gọi — ở quy mô này vẫn đủ nhanh nhờ `meetings_org_recorded_idx`, và đơn giản hơn nhiều. Chọn rollup **vì mục tiêu học** (roadmap), không vì cần hiệu năng hôm nay; ghi thẳng điều đó vào tài liệu                                                           |
| Q2  | Cắt ngày theo múi giờ nào?           | ★ `Asia/Ho_Chi_Minh` cố định, dùng lại `REPORT_TIME_ZONE`; một cuộc họp thuộc ngày VN của `recorded_at` (biên 16:59:59Z / 17:00:00Z có test). Thay thế: thêm cột múi giờ vào `organizations` — để mốc sau                                                                                                                                                                                                                                                                                                                                                                                     |
| Q3  | Con số nào vào rollup?               | ★ Theo ngày họp (`recorded_at`, meeting chưa xoá): `meetings_total`, `meetings_completed`, `meetings_failed`, `recorded_ms` (tổng `duration_ms` mọi meeting đã biết thời lượng), `transcribed_ms` (tổng `duration_ms` meeting `completed`). Tỉ lệ lỗi = `failed / (completed + failed)` (chỉ tính meeting đã kết thúc; đang xử lý không làm tỉ lệ nhảy). Xoá meeting → biến khỏi mọi số                                                                                                                                                                                                       |
| Q4  | Con số không cộng được tính ở đâu?   | ★ **Tính trực tiếp** khi gọi API (không vào rollup, vì "người phân biệt" của 7 ngày ≠ tổng 7 con số hằng ngày): thành viên hoạt động = số chủ meeting phân biệt có meeting họp trong khoảng (không có dữ liệu "đăng nhập theo thời gian" — nêu rõ hạn chế), tổng thành viên, **dung lượng** = tổng `uploads.size_bytes` của meeting chưa xoá (số hiện tại, không phải chuỗi thời gian), **top 5 kênh** theo số meeting được share trong khoảng, **việc cần làm**: số `open`, số quá hạn (hạn trước hôm nay VN), số `done` có `completed_at` trong khoảng                                      |
| Q5  | Khi nào rollup được tính lại?        | ★ Ba đường, cùng một hàm `rollupDay(orgId, day)`: (a) cron mỗi 5 phút tính lại **hôm nay và hôm qua** của mọi tổ chức có meeting đổi trong 10 phút qua (`updated_at`); (b) **theo sự kiện** sau commit khi xoá meeting hoặc sửa `recorded_at` (job cho ngày cũ **và** ngày mới — nếu không, ngày cũ giữ số sai mãi); (c) job đêm 03:30 tính lại 92 ngày gần nhất làm lưới an toàn (đúng cửa sổ API cho xem — xem Q8). Số "hôm nay" có thể trễ tới 5 phút — ghi vào tài liệu và `computedAt` trong response. Thay thế: chỉ (a)+(c) — đơn giản hơn nhưng xoá meeting cũ chỉ giảm số sau một đêm |
| Q6  | Tính lại đồng thời cùng (org, ngày)? | ★ Bọc trong `pg_advisory_xact_lock(hash(org, ngày))`: không có khoá thì A đọc nguồn lúc t1, B đọc lúc t2 > t1 và ghi trước, rồi A ghi **đè số cũ** lên số mới. Có test hai lần tính song song sau khi sửa nguồn (đột biến bỏ khoá phải đỏ)                                                                                                                                                                                                                                                                                                                                                    |
| Q7  | Quyền & riêng tư                     | ★ Quyền mới `org.dashboard.read` = Owner / Admin (Member → 403, người ngoài org → 404 do `OrgMemberGuard`). Response chỉ có số + **tên và id kênh** ở top kênh (Owner / Admin đã thấy metadata mọi kênh theo D2, kể cả kênh riêng tư; không có tiêu đề meeting, không có tên người, không có chữ của việc). Test khẳng định JSON không chứa tiêu đề meeting / nội dung việc đã dựng trong fixture. Thay thế: ẩn kênh riêng tư khỏi top — an toàn hơn nhưng lệch D2                                                                                                                            |
| Q8  | Hình dạng API                        | ★ `GET /orgs/:orgId/dashboard?from=&to=&granularity=day\|week`. `from`/`to` là ngày VN `YYYY-MM-DD` bao gồm hai đầu; mặc định 30 ngày gần nhất tới hôm nay; `from > to`, khoảng > 92 ngày, hoặc `from` cũ hơn 92 ngày tính từ hôm nay → 400 (rollup chỉ được đảm bảo phủ cửa sổ 92 ngày gần nhất; job đêm tính lại đúng cửa sổ đó). `series` được **điền đủ ngày 0** (không bỏ ngày trống); `granularity=week` gom theo tuần bắt đầu Thứ Hai (cùng quy ước báo cáo tuần). Số liệu lưu trữ / thành viên / việc là số của **thời điểm gọi** (các trường này không đổi theo `granularity`)       |
| Q9  | RLS                                  | ★ `org_daily_stats` có `org_id` + policy `org_id = app_current_org_id()` cùng mẫu M11/M12 (api đọc dưới ngữ cảnh org; worker BYPASSRLS ghi)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Thay đổi thiết kế

- **Bảng mới `org_daily_stats`** (migration `0019`, RLS viết tay): `org_id` FK `organizations` CASCADE, `day date`, `meetings_total`, `meetings_completed`, `meetings_failed` `int`, `recorded_ms`, `transcribed_ms` `bigint`, `computed_at timestamptz`; `PRIMARY KEY (org_id, day)`; CHECK mọi số ≥ 0 và `completed + failed <= total`.
- **Job:** `stats.rollup` `{ orgId, day }` (queue `default`), jobId `stats.rollup.<orgId>.<day>.<lần>` (theo skill `bullmq-jobs`, không dấu `:`); tick `stats.tick` mỗi 5 phút, `stats.reconcile` 03:00 giờ VN. Processor chỉ đăng ký trong `WorkerModule`.
- **API mới:** `GET /orgs/:orgId/dashboard` (tag `Dashboard`).
- **Quyền mới:** `org.dashboard.read` trong `organization.policy.ts` + ma trận ở 04.
- **Dependency mới:** không.

## Các bước

- [x] **B1 — Schema + câu tính lại một ngày**
  - Việc: bảng `org_daily_stats` + migration `0019` (đọc SQL sinh ra, thêm RLS bằng tay); repository `rollupDay(orgId, day)` bằng MỘT câu `INSERT … SELECT … ON CONFLICT DO UPDATE` (biên ngày VN tính bằng `(day)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'` như `meetingsForWeek`); `readRange(orgId, from, to)`; sửa 03.
  - Test (integration): từng CHECK; biên 16:59:59.999Z / 17:00:00Z; đếm đúng theo trạng thái, meeting đang xử lý không vào `completed`/`failed`; meeting đã xoá bị loại; **chạy hai lần cho cùng kết quả**; sửa nguồn rồi tính lại → số đổi theo; ngày không còn meeting → dòng về 0 (không để số cũ); org khác không lẫn; RLS (api không thấy org khác).
- [x] **B2 — Job rollup + tick + sự kiện + đêm**
  - Việc: `StatsRollupService` (khoá advisory theo (org, ngày) — Q6), processor, tick 5 phút tìm (org, ngày) có meeting đổi, job theo sự kiện khi xoá meeting / sửa `recorded_at` (enqueue SAU commit, ngày cũ và mới), job đêm; sửa 06.
  - Test: hai `rollupDay` song song sau khi sửa nguồn → kết quả cuối khớp nguồn (đột biến bỏ khoá advisory → đỏ); xoá meeting cũ → job tính lại đúng ngày của nó; sửa `recorded_at` sang ngày khác → cả hai ngày đúng; tick chỉ chọn org có thay đổi; payload chỉ ID, jobId không có `:`.
- [x] **B3 — Số liệu tính trực tiếp**
  - Việc: repository thành viên hoạt động / tổng, dung lượng, top 5 kênh, số việc (open / overdue / done trong khoảng).
  - Test (integration): bảng kỳ vọng dựng tay cho từng số; meeting đã xoá không tính dung lượng / thành viên hoạt động; kênh đã xoá không vào top; người rời org; hạn "hôm nay" chưa quá hạn (cùng quy ước M12); org khác không lẫn.
- [x] **B4 — Service + quyền**
  - Việc: `DashboardService` (validate khoảng, điền đủ ngày, gom tuần Thứ Hai, tính tỉ lệ lỗi, `computedAt`), quyền `org.dashboard.read`; sửa 04.
  - Test (unit): bảng khoảng ngày (1 ngày, 92 / 93 ngày, `from > to`, qua năm, biên tuần), điền ngày trống, gom tuần, tỉ lệ lỗi khi mẫu = 0 (không chia cho 0), ma trận quyền Owner / Admin / Member.
- [x] **B5 — Controller + DTO + e2e + Swagger**
  - Việc: route, DTO (`*ResponseDto`, JSDoc), `@ApiErrorResponses(400, 403)`, `RateLimit` nếu cần, `openapi.json`; sửa 05.
  - Test (e2e): Owner / Admin 200, Member 403, người ngoài 404; **JSON không chứa tiêu đề meeting / tên việc / tên người** đã dựng trong fixture; xoá meeting rồi (gọi rollup) số giảm đúng; đầu vào sai → 400; tuần vs ngày cho cùng tổng.
- [x] **B6 — Tài liệu + đóng mốc**
  - Việc: 02 (module), 03, 04, 05, 06, 07 nếu có mã lỗi mới; README + CLAUDE.md (hàng M17); bài học; `pnpm build && pnpm openapi:export`; chạy đủ `test:e2e`.

Mỗi bước kèm **đột biến** cho phần có logic (bỏ lọc `deleted_at`, `completed` ↔ `failed` lẫn, bỏ khoá advisory, biên ngày lệch UTC, bỏ điền ngày trống, bỏ kiểm quyền…) như M12.

## Tiêu chí hoàn thành

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [x] `pnpm test:e2e` xanh ở CI (PR #15: Lint · Test · Build và Docker image đều pass)
- [x] Admin xem số liệu 30 ngày; Member gọi bị 403; người ngoài 404
- [x] Xoá meeting (kể cả meeting cũ) rồi rollup → số giảm đúng; sửa `recorded_at` → cả hai ngày đúng
- [x] Rollup chạy lại / chạy song song không đếm trùng, không để số cũ ghi đè số mới (có đột biến)
- [x] Response không chứa tiêu đề / nội dung / tên người (có test)
- [x] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Bảng rollup vs đếm trực tiếp: độ tươi dữ liệu đổi lấy chi phí, và khi nào rollup **không** đáng
- Rollup idempotent bằng cách **tính lại từ nguồn** thay vì cộng dồn; khoá advisory chống ghi đè số cũ lên số mới
- Số cộng được vs không cộng được (đếm phân biệt)
- Cắt ngày theo múi giờ trong SQL; biên ngày; dữ liệu nguồn đổi làm ngày cũ sai (sửa `recorded_at`)
- Số tổng hợp cũng cần phân quyền và kiểm tra rò rỉ

## Điều học được / bẫy gặp phải

1. **Aggregate không `GROUP BY` luôn trả đúng một dòng — kể cả khi bảng rỗng.** `rollupDay` dựa vào đó: ngày hết meeting (xoá, hoặc `recorded_at` chuyển sang ngày khác) được ghi đè về 0 thay vì để số cũ. Nếu viết `GROUP BY day` thì ngày rỗng không ra dòng nào, `ON CONFLICT` không chạy và số cũ nằm lại. Test "ngày hết meeting → về 0" canh điều này.
2. **Ngày mới của một meeting bị chuyển KHÔNG tự cập nhật ngày cũ** (test cuối cùng ghi lại bằng chính hành vi: ngày cũ về 0 chỉ khi nó được tính lại). Đó là lý do cần job theo sự kiện (B2): rollup chỉ biết ngày đang được hỏi.
3. **Đột biến B1: 19/19 đỏ** (cắt ngày UTC, biên +2, bỏ `deleted_at`, `DO NOTHING`, failed đếm nhầm completed, transcribed không lọc completed, bỏ lọc org / `total`, `readRange` lệch biên / org / thứ tự; migration: policy RLS, hai CHECK, CASCADE, `bigint` → `integer`). Ba đột biến đầu bị lỗi cách viết (chuỗi sai sau khi prettier định dạng lại; SQL hỏng → "NO RESULT" không phải tín hiệu) nên chạy lại — vẫn là quy tắc cũ: xác nhận đột biến thật sự áp được và biên dịch.
4. **BullMQ nuốt `add()` trùng jobId kể cả job đã completed** — với rollup, `stats.rollup.<org>.<ngày>` cố định sẽ làm một lần xoá meeting SAU khi rollup ngày đó đã chạy không bao giờ được tính lại. Hậu tố theo loại yêu cầu (`e<ms>` / `t<ô 5 phút>` / `n<ngày>`); tick chạy lại trong cùng ô 5 phút thì cùng id (một job). Có test unit cho dạng jobId (không `:`, hậu tố khác → id khác).
5. **Khoá advisory là cách deterministic để test race "đọc cũ ghi đè mới".** Giữ khoá từ pool khác, bắt đầu `rollupDay` (bị chặn), đổi nguồn, nhả khoá → kết quả phải thấy nguồn MỚI. Bỏ khoá thì `rollupDay` chạy ngay với nguồn cũ → test đỏ. Không cần dựng interleaving trong một câu SQL.
6. **Sửa `recorded_at` trong cùng ngày VN không cần job** — test e2e bắt đúng một chỗ thừa trong code lần đầu (xếp job cả khi `from === to`).
7. **Tick tìm ngày bằng `updated_at` của meeting, không có index.** Thêm index `(updated_at)` sẽ làm mất HOT update của bảng `meetings` (pipeline sửa liên tục, `updated_at` luôn đổi). Quét tuần tự 5 phút/lần chấp nhận được ở quy mô này; ghi trong comment `findChangedDays` để đo lại khi bảng lớn.
8. **Hai việc song song bằng worktree.** B3 (số tính trực tiếp) giao cho agent trong worktree riêng, B2 làm tay song song. Điểm cần dặn trước: file riêng cho từng bên (`dashboard-live.repository.ts`, `dashboard.types.ts`) để không xung đột; khi gộp mình chuyển hai repository vào `repositories/` (quy tắc thư mục). Bẫy: `pnpm format` ghi lại 20 file `migrations/meta/*.json` — phải `git checkout -- migrations` sau mỗi lần format (agent cũng gặp). Worktree bị khoá bởi tiến trình agent nên `git worktree remove` cần `unlock` trước.
9. **Đột biến B2: 22/22 đỏ** (khoá advisory, khoá không gồm ngày, clamp span, hướng lùi ngày, lookback, ngày tick, jobId, job đêm bỏ `span` / hậu tố / chỉ trang đầu, cắt ngày UTC, biên `since`, keyset `gte`, bỏ `limit`, xoá không xếp job, sửa chỉ ngày mới, `catch` enqueue, processor thiếu case, thiếu lịch, jobId có `:`). Lượt đầu 3 sống sót — đều là lỗ hổng test thật: job đêm chỉ duyệt trang đầu (thiếu ca nhiều trang → đưa kích thước lô thành tham số), `>` thay `>=` ở biên `since` (thiếu ca đúng mốc), và một chuỗi đột biến không khớp sau prettier.
10. **Đột biến B3 (agent chạy): 41 đột biến, 34 đỏ, 7 tương đương / không test được**, 1 lỗ hổng thật (top kênh phải lấy ngày từ `meeting_shares.recorded_at`, không phải `meetings.recorded_at`) đã bổ sung test. Các đột biến tương đương đều do ràng buộc DB chặn hộ (`uploads_meeting_uq`, CHECK `completed ⇔ meeting_id`, PK `meeting_shares`, CHECK `status='done' ⇔ completed_at`) — mình đã tự đọc code và đối chiếu từng cái.
11. **Sửa thiết kế giữa chừng: cửa sổ xem 92 ngày, job đêm 92 ngày (plan cũ: 35).** Ngày chưa có dòng rollup hiện 0 dù có meeting — sai âm thầm. Job đêm 35 ngày + API cho xem khoảng 92 ngày ở BẤT KỲ đâu trong quá khứ để lại khoảng hở (lịch sử trước M17, hoặc ngày 60 ngày trước). Chọn: API chỉ cho xem trong 92 ngày gần nhất và job đêm tính lại đúng 92 ngày → sau đêm đầu tiên mọi ngày xem được đều có dòng; ngày xa hơn thay đổi thì tick / sự kiện vẫn bắt. Giá: ~92 câu SQL có index cho mỗi tổ chức mỗi đêm. Thay thế đã loại: backfill lười khi đọc (GET có tác dụng phụ ghi), CLI backfill thủ công. Trước đêm đầu tiên sau deploy dashboard hiện 0 — `computedAt: null` là tín hiệu.
12. **Tổng phút phải cộng MILI GIÂY rồi mới đổi phút.** 3 ngày × 40 s: mỗi ngày làm tròn 1 phút → cộng ngày = 3, đúng = 120 s = 2 phút. Cùng lý do tổng tuần = tổng cả khoảng. Đột biến "tổng từ chuỗi đã làm tròn" sống sót lượt đầu (fixture của mình trùng hợp làm tròn khớp) → thêm fixture cố ý lệch.
13. **`failureRate` có `null` khác `0`.** `null` = chưa có meeting nào kết thúc (không có gì để đo); `0` = có kết thúc, không lỗi. Mẫu số là `completed + failed`, không phải tổng meeting: meeting đang xử lý không làm tỉ lệ nhảy. Làm tròn 4 chữ số.
14. **Phép tính ngày dùng chung ở `report-week.ts`** (`isCalendarDate`, `daysBetween`): số học trên ngày lịch, không cộng mili giây — kiểm 92 ngày qua năm và tháng 2 (đúng 92 / 93 ngày có ca riêng). Ca sai của chính mình: tôi đếm nhầm 1/12 → 2/3 là 93 ngày (thực tế 92) — test viết tay phải tính ngày bằng tay cho kỹ.
15. **Đột biến B4: 22/22 đỏ.** Lượt đầu 3 sống sót, đều là lỗ hổng test thật: `computedAt` lấy mốc nhỏ nhất (mọi dòng cùng mốc), top kênh luôn 1 (fixture chỉ một kênh), tổng từ chuỗi đã làm tròn → thêm tổ chức nhiều dữ liệu (7 kênh, 3 ngày lệch làm tròn, `computed_at` đặt tay).
16. **`@RequireOrgPermission` chạy trước pipe/validation → Member gọi với `from=sai` vẫn 403, không phải 400.** Có test riêng: người không có quyền không được biết gì về định dạng đầu vào. Đột biến bỏ decorator làm 8 test đỏ (cả outsider cũng lọt vì guard thành viên gắn kèm decorator này).
17. **Hai lớp kiểm ngày, một đột biến tương đương.** DTO chỉ chặn chuỗi sai DẠNG (`Matches`); ngày không có thật (`2026-02-30`), khoảng, cửa sổ do `resolveRange` kiểm. Bỏ `Matches` ở DTO không đổi hành vi (service vẫn trả 400 cùng `VALIDATION_FAILED`) — giữ vì chặn sớm và Swagger mô tả đúng dạng.
18. **Đột biến B5: 9 đột biến, 8 đỏ + 1 tương đương** (bài 17): bỏ/ đổi quyền, không truyền query, bỏ `IsIn granularity`, `computedAt`/`series`/`topChannels`/`range` rơi khỏi DTO. Test rò rỉ dựng tiêu đề, nội dung việc, email, tên hiển thị có dấu hiệu nhận dạng riêng rồi tìm trong JSON.
19. **Test "xoá → số giảm" ở e2e gọi `rollupDay` thủ công** (worker không chạy trong file này); đường api→queue→worker→DB đã có ở `stats-rollup.e2e-spec.ts`. Tách hai nửa để mỗi test chỉ kiểm một thứ.
