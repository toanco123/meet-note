# M12 — Action items

- **Trạng thái:** Chờ duyệt plan
- **Nhánh:** `m12-action-items`
- **Tài liệu thiết kế liên quan:** `docs/design/03-database.md` (§ meeting, RLS), `04-authorization.md` (§3 quyền xem meeting, mục sửa transcript M13), `05-api.md`, `06-flows.md` §1.2 (pipeline) và §2 (báo cáo tuần), `10-roadmap.md` (M12). Plan M6 (summarizer), M9 (báo cáo), M13 (khoá lạc quan `If-Match`)

## Mục tiêu

Sau khi pipeline xong, mỗi meeting có danh sách **việc cần làm** có người phụ trách (khi nhận ra được) và hạn chót. Người dùng sửa, giao việc, đổi trạng thái (xong / bỏ), và xem **"việc của tôi"** xuyên mọi meeting họ xem được. Báo cáo tuần của kênh thêm mục **việc quá hạn**.

Điểm khó của mốc: dữ liệu **vừa do máy sinh vừa do người sửa**. Chạy lại không được sinh trùng, cũng không được ghi đè bản đã sửa tay. Và LLM trả "Bình" / "thứ sáu" là chữ tự do — phải biến thành người thật / ngày thật mà **không đoán bừa**.

## Hiện trạng (không làm lại)

- Tóm tắt (`meeting_summaries.content`) đã có `actionItems: [{ owner: string|null, task, due: string|null }]` — chữ tự do, một dòng / meeting, bị ghi đè khi chạy lại (M6). Báo cáo tuần (M9) đã gom `actionItems` của tóm tắt.
- Khoá lạc quan: `parseIfMatchVersion` + `ETag` (M13). Mẫu `ON DELETE SET NULL (cột)` cho composite FK: `meetings.owner_id` (migration 0007). Quyền xem meeting: `meetingVisibleTo` (M6b).

## Ngoài phạm vi của mốc này

- Nhắc việc sắp / quá hạn, thông báo "bạn được giao việc" (dùng hạ tầng M10 — để mốc sau)
- Bình luận, việc con, việc lặp, độ ưu tiên, thứ tự kéo thả
- Nút "trích lại action item từ tóm tắt mới" (chạy lại summarizer rồi gộp) — mốc này chỉ **bảo vệ** để việc đó làm được sau (Q3)
- Realtime, xuất file, webhook (M14)
- Sửa tay nhiều việc một request

## Quyết định cần duyệt (★ = đề xuất)

| #   | Câu hỏi                            | Lựa chọn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Lưu ở đâu?                         | ★ **Bảng riêng `action_items`** (một dòng / việc): có trạng thái, người phụ trách, `version`, truy vấn "việc của tôi" bằng index. Thay thế: giữ trong `summary.content` jsonb — không truy vấn xuyên meeting được, và chạy lại summary xoá hết bản sửa                                                                                                                                                                                                                                                                                                                                               |
| Q2  | Trích bằng cách nào?               | ★ **Dùng chính lần gọi tóm tắt** (không thêm lần gọi LLM): mở rộng schema đầu ra của summarizer thêm `dueDate` (ISO hoặc null), prompt nhận **ngày họp** để quy "thứ sáu" ra ngày; bump `promptVersion` `v1` → `v2`. Giữ `due` chữ gốc để hiển thị. Server **validate lại** `dueDate` (đúng dạng, trong khoảng ngày họp −1 ngày … +2 năm, ngoài khoảng → null). Thay thế: extractor riêng (thêm một lần gọi, thêm chi phí; chỉ đáng khi cần chất lượng cao hơn)                                                                                                                                      |
| Q3  | Chạy lại có sinh trùng / đè không? | ★ `action_items` có `origin` (`ai` \| `manual`) và `source_index`; **unique một phần `(meeting_id, source_index) WHERE origin = 'ai'`**; chèn bằng `ON CONFLICT DO NOTHING` **trong cùng transaction** với `completeSummarize` + `upsertSummary`. Retry/stuck-sweep chạy lại bước tóm tắt → không trùng; việc người đã sửa không bị đè (không có `UPDATE` nào từ pipeline). Hệ quả có chủ đích: **chạy lại tóm tắt KHÔNG thay danh sách việc** (muốn thế cần mốc "trích lại" — ngoài phạm vi). Không có `DELETE`: bỏ việc = trạng thái `dismissed` (xoá hẳn việc AI thì lần chạy lại sẽ chèn lại nó) |
| Q4  | Map tên → thành viên               | ★ Hàm thuần: chuẩn hoá (bỏ dấu, thường, bỏ khoảng trắng thừa) rồi khớp `display_name` của **thành viên org** theo (a) trùng cả tên, hoặc (b) trùng **tên gọi** (từ cuối của `display_name`, kiểu "Bình" ↔ "Nguyễn Văn Bình"). Chỉ gán khi **đúng MỘT** người khớp; không khớp hoặc nhiều người (hai "Bình") → `assignee_id = NULL`, giữ `owner_name` chữ gốc để người dùng giao tay. **Không bao giờ đoán.** Người xem việc vẫn bị lọc theo quyền xem meeting nên gán nhầm cũng không lộ nội dung cho người không xem được meeting                                                                   |
| Q5  | Giao tay cho ai?                   | ★ Assignee phải là thành viên org **và xem được meeting đó** (`meetingVisibleTo` với viewer = assignee) — giao việc cho người không xem được thì họ không thấy việc, vô nghĩa → 422. Mất tư cách thành viên org → `assignee_id` về NULL (`ON DELETE SET NULL (assignee_id)`)                                                                                                                                                                                                                                                                                                                         |
| Q6  | Ai sửa gì?                         | ★ Nội dung (`task`, `assigneeId`, `dueDate`), tạo việc thủ công, bỏ việc: **người quản lý meeting** (`canManageMeeting`, như M13). Đổi **trạng thái** (`open` ↔ `done`): thêm **người được giao** làm được. Xem: ai xem được meeting. Thay thế: mọi người xem được đều đổi trạng thái — dễ, nhưng ai cũng đóng được việc của người khác                                                                                                                                                                                                                                                              |
| Q7  | Chống ghi đè đồng thời             | ★ Dùng lại khoá lạc quan M13: cột `version`, `PATCH` bắt buộc `If-Match`, 412 / 428. Tách `parseIfMatchVersion` ra khỏi module transcripts thành tiện ích dùng chung (`src/common/http/`) và thêm mã `ACTION_ITEM_VERSION_MISMATCH` / `…_IF_MATCH_REQUIRED`                                                                                                                                                                                                                                                                                                                                          |
| Q8  | "Việc của tôi"                     | ★ `GET /orgs/:orgId/action-items?assignee=me&status=open&overdue=true&channelId=&cursor=&limit=`; điều kiện xem meeting nằm **trong câu truy vấn** (bài học M8 — lọc quyền sau khi cắt trang làm trang trống); keyset `(due_date NULLS LAST, id)`; index một phần `WHERE status = 'open'`. `overdue` = `due_date < hôm nay theo giờ VN` (cùng cách tính ngày với tuần báo cáo M9)                                                                                                                                                                                                                    |
| Q9  | Báo cáo tuần                       | ★ **Server ghép** mục `overdueActionItems` vào nội dung báo cáo (như `meetings`: model chỉ viết phần chữ, không tự bịa danh sách): việc `open`, `due_date` < đầu tuần sau, thuộc meeting chia sẻ vào kênh, tối đa 20 (+ `truncated`). Hiển thị người phụ trách bằng tên. Không đổi prompt model                                                                                                                                                                                                                                                                                                      |
| Q10 | RLS & ràng buộc                    | ★ `org_id` + composite FK `(meeting_id, org_id)` → `meetings` (CASCADE) + RLS cùng mẫu `meetings`; `CHECK` status / origin / `version >= 1` / `char_length(task) BETWEEN 1 AND 500` / `origin='ai' ⇒ source_index IS NOT NULL`. Dữ liệu cũ: meeting đã `completed` trước M12 **không** có việc (không backfill; ghi vào tài liệu — muốn có phải chờ mốc "trích lại")                                                                                                                                                                                                                                 |

## Thay đổi thiết kế

- **Bảng mới `action_items`** (migration `0018`, RLS viết tay):
  - `id uuid PK uuidv7`, `org_id`, `meeting_id` (composite FK CASCADE), `origin text`, `source_index int NULL`
  - `task text`, `owner_name text NULL` (chữ gốc LLM), `assignee_id uuid NULL` (composite FK `(org_id, assignee_id)` → `organization_members`, `ON DELETE SET NULL (assignee_id)`)
  - `due_text text NULL`, `due_date date NULL`, `status text` (`open` | `done` | `dismissed`), `completed_at`, `completed_by` (FK `users` SET NULL)
  - `version int NOT NULL DEFAULT 1`, `created_by uuid NULL` (manual), `created_at`, `updated_at`
  - Index: unique một phần AI `(meeting_id, source_index)`; theo meeting `(meeting_id, id)`; "việc của tôi" `(org_id, assignee_id, due_date NULLS LAST, id) WHERE status = 'open'`; index phía tham chiếu cho `completed_by`, `created_by`
- **Summarizer:** schema đầu ra thêm `dueDate`; `SummaryInput` thêm `recordedAt`; `promptVersion = 'v2'`; parser validate `dueDate`
- **API mới:**
  - `GET /orgs/:orgId/meetings/:meetingId/action-items` (người xem được; chưa `completed` → danh sách rỗng)
  - `POST` cùng đường dẫn (tạo thủ công, người quản lý meeting)
  - `PATCH /orgs/:orgId/action-items/:itemId` (`If-Match`; body một phần: `task`, `assigneeId`, `dueDate`, `status`)
  - `GET /orgs/:orgId/action-items?…` (việc xuyên meeting)
- **Quyền:** không đổi ma trận kênh; thêm mục vào 04 (như M13). Hàm thuần `decideActionItemWrite`
- **Dependency mới:** không

## Các bước

- [ ] **B1 — Schema + repository**
  - Việc: bảng, CHECK, index, RLS, migration `0018` (đọc SQL sinh ra, thêm `ON DELETE SET NULL (assignee_id)` và RLS bằng tay); repository cơ bản (`insertAiIfAbsent` bằng `ON CONFLICT DO NOTHING`, `listByMeeting`, `update` có điều kiện version); sửa 03.
  - Test (integration): CHECK từng cái; unique AI chặn trùng nhưng `manual` không dính; `ON CONFLICT DO NOTHING` chạy hai lần → một bộ; gỡ thành viên org → `assignee_id` NULL còn `org_id` nguyên; RLS (api không thấy org khác, đúng mẫu `meetings`); sửa đúng / sai version (đột biến bỏ điều kiện `version`).
- [ ] **B2 — Summarizer trả `dueDate`**
  - Việc: mở rộng schema JSON + prompt (nhận ngày họp, múi giờ VN), `promptVersion v2`, parser validate `dueDate` (dạng, khoảng hợp lệ), Fake sinh `dueDate` quy ước, `SummaryInput.recordedAt` truyền từ pipeline; báo cáo tuần (M9) không vỡ vì `actionItems` thêm field.
  - Test (unit): bảng `dueDate` hợp lệ / sai dạng / ngoài khoảng / null; model trả thiếu `dueDate` (tương thích ngược → null); stub HTTP Anthropic nhận đúng ngày họp trong prompt (integration cũ `anthropic-summarizer`).
- [ ] **B3 — Map tên → thành viên + trích trong pipeline**
  - Việc: hàm thuần `matchAssignee(ownerName, members)` (Q4); trong cùng transaction với `completeSummarize` + `upsertSummary`: tải thành viên org (id + tên), map, `insertAiIfAbsent`; sửa 06 §1.2.
  - Test: unit bảng (trùng cả tên, tên gọi, có dấu / không dấu, hai người cùng tên → null, không khớp → null, tên rỗng, "mọi người"); integration (Fake summarizer): sau tóm tắt có đúng N việc, chạy **hai lần** không trùng, **việc đã sửa / đã `done` không bị đổi** (đột biến: đổi `DO NOTHING` thành `DO UPDATE` → đỏ), transaction rollback thì không để lại việc mồ côi.
- [ ] **B4 — API đọc (theo meeting + "việc của tôi")**
  - Việc: 2 route GET, DTO, `@ApiPaginatedResponse`, truy vấn "việc của tôi" ghép `meetingVisibleTo` trong câu; `overdue` theo ngày VN; sửa 05.
  - Test: e2e quyền xem (không xem được meeting → 404 / việc không lộ ở danh sách xuyên meeting); test đối chiếu kiểu oracle (như `meeting-list-oracle`): mọi người xem × bộ lọc, duyệt hết trang, so với "sự thật" dựng tay; keyset không lặp / sót; `overdue` đúng quanh nửa đêm VN.
- [ ] **B5 — API ghi (tạo, sửa, đổi trạng thái)**
  - Việc: `POST`, `PATCH` + `If-Match`; tách `parseIfMatchVersion` ra `src/common/http/` (giữ import cũ chạy được hoặc sửa chỗ dùng); `decideActionItemWrite` (Q6); kiểm assignee (Q5, 422); `completed_at/by` khi `done`; audit khi người không phải chủ meeting sửa nội dung.
  - Test: bảng quyền (chủ meeting, assignee đổi được trạng thái nhưng không đổi nội dung, member khác, OrgAdm với meeting có chủ / không chủ); 412 / 428; **race:** 6 PATCH song song cùng version → một thắng; giao cho người không xem được → 422; giao rồi người đó rời org → `assignee_id` NULL và PATCH tiếp bằng `If-Match` hiện tại vẫn chạy; thao tác trên việc `dismissed`.
- [ ] **B6 — Báo cáo tuần có mục việc quá hạn**
  - Việc: repository lấy việc quá hạn của các meeting chia sẻ vào kênh, `ReportContent.overdueActionItems` + `truncated`, ghép ở `ReportGenerationService` (server, không qua model), DTO báo cáo; sửa 05 / 06 §2.
  - Test: unit chọn / cắt 20; integration: chỉ việc `open` + quá hạn + thuộc kênh; việc `done` / `dismissed` / không hạn / meeting không thuộc kênh bị loại; báo cáo cũ (không có field) vẫn đọc được (đột biến: bỏ lọc `status`).
- [ ] **B7 — Tài liệu + openapi + đóng mốc**
  - Việc: 02 (module), 03, 04, 05, 06, 07 (mã lỗi), roadmap nếu cần; `pnpm build && pnpm openapi:export`; README / CLAUDE.md; bài học.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở CI (local: 6 file cần ffmpeg lỗi do đã gỡ máy dev)
- [ ] Pipeline chạy lại không sinh việc trùng, không đè việc đã sửa (có đột biến)
- [ ] Map tên → thành viên không đoán bừa khi mơ hồ (bảng test + đột biến)
- [ ] "Việc của tôi" không lộ việc của meeting người gọi không xem được (oracle)
- [ ] Hai sửa song song cùng version: đúng một thành công (có đột biến)
- [ ] Báo cáo tuần có mục việc quá hạn, đúng lọc
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Dữ liệu **hai nguồn** (máy + người): khoá tự nhiên cho phần máy (`source_index`), không có `UPDATE` từ pipeline, tombstone (`dismissed`) thay vì `DELETE`
- Chuyển chữ tự do của LLM thành khoá ngoại **an toàn**: khớp duy nhất hoặc bỏ trống; validate lại mọi thứ model trả
- `ON DELETE SET NULL (cột)` cho composite FK mang `org_id` NOT NULL
- Truy vấn xuyên meeting có quyền xem trong câu + keyset trên cột nullable (`NULLS LAST`)
- Tái dùng khoá lạc quan (M13) ở tài nguyên thứ hai: tách phần chung ra đúng chỗ

## Điều học được / bẫy gặp phải

(Ghi sau khi xong mốc)
