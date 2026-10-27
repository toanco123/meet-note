# M13 — Sửa transcript

- **Trạng thái:** Đang làm
- **Nhánh:** `m13-edit-transcript`
- **Tài liệu thiết kế liên quan:** `docs/design/03-database.md` (`transcript_segments`), `04-authorization.md` (§ meeting), `05-api.md` (Meetings), `07-conventions.md`, `10-roadmap.md` (M13). Plan M8 (search / export), M6b (`canManageMeeting`)

## Mục tiêu

Chủ meeting sửa được nội dung một đoạn transcript (lỗi nhận dạng của Whisper). Hai người sửa cùng đoạn: một người thành công, người kia nhận **412** và không mất dữ liệu. Sau khi sửa, tìm kiếm (M8) và xuất SRT / VTT thấy ngay bản mới.

Mốc này dạy **khoá lạc quan** (cột `version`, `ETag` / `If-Match`) và đặt nó cạnh khoá bi quan `FOR UPDATE` đã dùng từ M1: khi nào một câu `UPDATE … WHERE version = $n` là đủ.

## Ngoài phạm vi của mốc này

- Sửa mốc thời gian (`startMs` / `endMs`), tách / gộp / thêm / xoá đoạn, đổi `seq`, đặt tên người nói
- Lịch sử bản sửa (bảng revisions) và hoàn tác — chỉ giữ `version`, `edited_at`, `edited_by`
- Tự tóm tắt lại / tạo lại báo cáo tuần khi transcript đổi (tóm tắt có thể lệch bản sửa; nói rõ ở Q5)
- Sửa hàng loạt nhiều đoạn một request
- Realtime phát sự kiện sửa (client tải lại khi cần)

## Quyết định cần duyệt (★ = đề xuất)

| #   | Câu hỏi                                      | Lựa chọn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Ai được sửa?                                 | ★ Cùng quyền sửa / xoá meeting: **chủ meeting** (`canManageMeeting`); meeting không chủ thì Owner / Admin org. Người khác kể cả xem được → 403. Thay thế: mọi người xem được đều sửa (kiểu wiki) — nhưng không ai chịu trách nhiệm nội dung và dễ phá                                                                                                                                                                                                                                                               |
| Q2  | Version ở cấp nào?                           | ★ **Từng đoạn** (`transcript_segments.version`, bắt đầu 1). Hai người sửa HAI đoạn khác nhau không xung đột. Thay thế: version cả meeting — đơn giản nhưng sửa đoạn 3 làm hỏng cuộc sửa đoạn 900 của người khác                                                                                                                                                                                                                                                                                                     |
| Q3  | Cơ chế chống ghi đè                          | ★ **Khoá lạc quan:** `UPDATE … SET text, version = version + 1 WHERE id AND version = $n RETURNING`; 0 dòng thì phân biệt "đoạn không còn" (404) với "version lệch" (412). Client gửi version qua header **`If-Match: "3"`**, server trả `ETag: "4"`. Thiếu `If-Match` → **428** (không cho ghi mù). Thay thế: `SELECT … FOR UPDATE` rồi so — đúng nhưng giữ khoá qua một vòng đọc; ở đây một câu `UPDATE` có điều kiện đã nguyên tử, không cần transaction riêng (khớp bảng chọn kỹ thuật skill `db-transactions`) |
| Q4  | Khi nào sửa được? Pipeline chạy lại thì sao? | ★ Chỉ khi meeting `completed` (409 nếu chưa). Hiện **không có đường nào chạy lại pipeline cho meeting đã `completed`** (`retry` chỉ cho `failed`), nên bản sửa không va chạm pipeline. Để tương lai (tạo lại transcript / tóm tắt) không lặng lẽ xoá bản sửa: `replaceSegments` **từ chối** (lỗi) nếu meeting đã có đoạn `version > 1` — một invariant có test, chưa phải tính năng                                                                                                                                 |
| Q5  | Tóm tắt sau khi sửa transcript               | ★ Không tự tóm tắt lại (ngoài phạm vi). Ghi rõ trong tài liệu: tóm tắt phản ánh transcript **lúc tạo**. Thay thế: đánh cờ `summary_stale` và nút "tóm tắt lại" — để mốc sau nếu cần                                                                                                                                                                                                                                                                                                                                 |
| Q6  | Audit                                        | ★ Ghi `transcript.segment.edited` (trong cùng câu lệnh / transaction) với `meetingId`, `seq`, `fromVersion`, `toVersion`; **không** ghi nội dung văn bản (transcript là dữ liệu nhạy cảm, audit sống lâu hơn). Chỉ khi người sửa không phải chủ (OrgAdm sửa meeting không chủ), như `meeting.retried`                                                                                                                                                                                                               |
| Q7  | Ràng buộc nội dung                           | ★ `text` sau khi trim phải 1–5000 ký tự (CHECK ở DB + validate DTO); chỉ sửa `text`. Sửa bằng đúng nội dung cũ vẫn tăng version (đơn giản, tránh nhánh đặc biệt)                                                                                                                                                                                                                                                                                                                                                    |
| Q8  | Rate limit                                   | ★ Route PATCH có `@Throttle` riêng (vd 120 / phút / người): sửa tay nhiều đoạn liên tục là bình thường, nhưng vẫn cần trần                                                                                                                                                                                                                                                                                                                                                                                          |
| Q9  | `GET transcript` trả thêm gì?                | ★ Mỗi đoạn thêm `version` (client lấy được số để gửi `If-Match`) và `editedAt` (null nếu chưa sửa)                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Thay đổi thiết kế

- **Bảng / cột / index mới** (migration `0017`, chỉ `ALTER TABLE transcript_segments`):
  - `version integer NOT NULL DEFAULT 1`, `CHECK (version >= 1)` (`transcript_segments_version_ck`)
  - `edited_at timestamptz NULL`, `edited_by uuid NULL` (FK `transcript_segments_edited_by_fk` → `users(id)` `ON DELETE SET NULL`, index phía tham chiếu `transcript_segments_edited_by_idx` partial `WHERE edited_by IS NOT NULL`)
  - `CHECK (char_length(text) >= 1)` (`transcript_segments_text_ck`). Cận trên 5000 chỉ ở DTO (đổi so với bản duyệt đầu, xem bài học 1)
  - Không bảng mới ⇒ **không thêm policy RLS**; bảng đã có RLS theo `org_id`. Cột `search` là generated nên tự cập nhật khi `text` đổi
- **API mới:** `PATCH /orgs/:orgId/meetings/:meetingId/transcript/segments/:seq` — header `If-Match`, body `{ text }` → 200 đoạn mới + `ETag`. Lỗi: 400 (body / `seq`), 403, 404, 409 (meeting chưa `completed`), 412 (version lệch), 428 (thiếu `If-Match`). `GET …/transcript` thêm `version`, `editedAt`
- **Quyền mới:** không thêm quyền trong ma trận kênh; dùng `canManageMeeting` (04 §meeting thêm một dòng "Sửa transcript")
- **Dependency mới:** không

## Các bước

- [x] **B1 — Schema + repository**
  - Việc: cột `version`, `edited_at`, `edited_by`, 2 CHECK, index, migration `0017` (đọc SQL sinh ra; `NOT NULL DEFAULT 1` an toàn với dữ liệu cũ); `TranscriptsRepository.editSegment(meetingId, seq, expectedVersion, text, actorId)` — một `UPDATE … WHERE meeting_id AND seq AND version = $n RETURNING`, 0 dòng thì một `SELECT` phân biệt 404 / 412; sửa 03 §`transcript_segments`.
  - Test (integration, Postgres thật): sửa đúng version → `version + 1`, `edited_*` đặt; sai version → trả "lệch" và dữ liệu nguyên; đoạn không có → "không thấy"; CHECK chặn `text` rỗng / quá dài; `search` đổi theo (tìm từ mới ra, từ cũ không còn); **concurrency: hai `editSegment` song song cùng version → đúng một thành công** (đột biến: bỏ điều kiện `version = $n` → đỏ).
- [x] **B2 — Service + policy**
  - Việc: `TranscriptsService.editSegment(membership, actor, meetingId, seq, expectedVersion, text)`: tải meeting kèm điều kiện xem (không thấy → 404), `canManageMeeting` (không → 403), `status = completed` (409), gọi repository, audit khi người sửa không phải chủ, map kết quả → `Errors.*`. Thêm lỗi vào catalog: `TranscriptSegmentNotFound` (404), `TranscriptVersionMismatch` (412), `TranscriptEditRequired` (428), `MeetingNotEditable` (409) — kiểm tên hợp lệ với `ErrorCode`.
  - Test: unit cho quyết định quyền (bảng chủ / OrgAdm-meeting-không-chủ / OrgAdm-meeting-có-chủ / member); integration cho service (audit chỉ khi không phải chủ, không chứa `text`).
- [x] **B3 — Controller + DTO + e2e**
  - Việc: route PATCH, pipe đọc `If-Match` (chấp nhận `"3"` và `3`; từ chối `W/"3"`, `*`, danh sách — bài học 8), `ETag` response header, `@Throttle`, DTO `EditSegmentDto` / thêm `version`, `editedAt` vào response đoạn; Swagger `@ApiErrorResponses(400, 403, 404, 409, 412, 428)`; sửa 05.
  - Test (e2e): bảng quyền (chủ ✓; member khác ✗ 403; người ngoài 404; meeting `summarizing` 409); thiếu `If-Match` 428, sai định dạng 400, lệch version 412; **hai request song song cùng `If-Match`**: một 200 + một 412, bản cuối là của người thắng; sửa xong `GET transcript` thấy `version` mới; rate limit.
- [ ] **B4 — Tìm kiếm, xuất file, invariant pipeline**
  - Việc: `replaceSegments` từ chối khi đã có đoạn đã sửa (Q4); không đổi code search / export (cột generated + đọc từ bảng) nhưng thêm test chứng minh.
  - Test: sửa "kế hoạch" → "kế toán": search `ke toan` ra, `ke hoach` không ra đoạn đó; export SRT/VTT chứa bản mới; `replaceSegments` ném lỗi khi có đoạn `version > 1` và không xoá gì (nằm trong integration của pipeline; **cần ffmpeg nên viết ở mức repository, không cần pipeline thật**).
- [ ] **B5 — Tài liệu + openapi + đóng mốc**
  - Việc: 03, 04 (một dòng), 05 (route + `If-Match`/`ETag` + mã 412/428), 07 (mã lỗi + quy ước "khoá lạc quan"), 10-roadmap nếu cần; `pnpm build && pnpm openapi:export`; README / CLAUDE.md; bài học.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở CI (local: 6 file cần ffmpeg lỗi do đã gỡ máy dev)
- [ ] Hai sửa song song cùng version: đúng một thành công, không mất dữ liệu (có đột biến bỏ điều kiện `version`)
- [ ] Không sửa được khi thiếu `If-Match` (428), sai version (412)
- [ ] Search và export phản ánh bản sửa
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Khoá lạc quan: cột `version`, `ETag` / `If-Match`, 412 vs 428, và chỗ nó **thay** được `FOR UPDATE` (một `UPDATE` có điều kiện) so với chỗ không thay được
- Phân biệt "0 dòng vì không tồn tại" và "0 dòng vì version lệch" mà không race
- Generated column `tsvector` tự theo dữ liệu: sửa `text` là index tìm kiếm tự cập nhật
- Viết invariant bảo vệ dữ liệu người dùng khỏi một tính năng tương lai (Q4)

## Điều học được / bẫy gặp phải

1. **CHECK cận trên của DB sẽ chặn nhầm đầu ra Whisper.** Bản plan đầu đặt `CHECK (char_length(text) BETWEEN 1 AND 5000)`. Nhưng cận 5000 là luật của đường SỬA TAY; đặt ở DB thì một đoạn Whisper dài bất thường làm `replaceSegments` lỗi và cả pipeline meeting `failed` vì một luật không liên quan. Đã đọc `whisper-cpp.speech-to-text.ts`: đoạn rỗng đã bị lọc, nên cận dưới `>= 1` an toàn; cận trên chuyển sang DTO (B3).
2. **Đột biến B1 (4/4 đỏ):** bỏ `version = $n` khỏi WHERE (2 test đỏ, gồm test 10 lần song song), không tăng version, `version_mismatch` luôn thành `not_found`, không ghi `edited_by`. Script đột biến khôi phục bằng `cp` từ bản lưu thay vì `git checkout`, vì file chưa commit — `git checkout` sẽ xoá luôn code mới.
3. **Dùng lại `MEETING_NOT_COMPLETED` thay vì mã mới `MeetingNotEditable` (đổi so với plan).** Cùng điều kiện nghiệp vụ (meeting chưa xong), chỉ khác câu chữ nên thêm `Errors.transcript.notEditable()` với mã cũ — client đã biết xử lý mã đó cho tóm tắt / export. 412 và 428 là hai mã mới (`TRANSCRIPT_VERSION_MISMATCH`, `TRANSCRIPT_IF_MATCH_REQUIRED`) cộng `TRANSCRIPT_SEGMENT_NOT_FOUND`. Lỗi 412 không đính kèm `currentVersion` vào `details` (kiểu `ErrorDetail` là `{field, message}` cho lỗi validate, nhét số vào đó là lạm dụng): client tải lại đoạn là có `version` mới.
4. **Không khoá dòng meeting khi sửa — chọn có chủ đích (cùng tinh thần M9 bài học 30).** Skill `authorization` bảo kiểm lại quyền sau khi khoá; ở đổi quyền / sở hữu là bắt buộc. Sửa transcript thì tranh chấp chỉ giữa hai lần sửa cùng đoạn, `version` trong WHERE phân xử nguyên tử. Thứ có thể đổi giữa kiểm tra và ghi (chủ rời org, meeting bị xoá mềm) tệ nhất thêm MỘT lần sửa. Đã ghi vào comment của `editSegment` kèm điều kiện đảo ngược ("nếu thao tác ghi sau này không đảo ngược được thì phải khoá").
5. **Test service để ở e2e, không ở integration.** `TranscriptsService` cần `MeetingsService` (nhiều phụ thuộc) và `OrgContext` cho RLS; dựng bằng `createTestApp` + `OrgContext.runInOrg` ngắn hơn nhiều so với tự lắp tay. Bẫy gặp: `addChannelMember(db, channel, orgId, userId)` nhận ĐỐI TƯỢNG kênh ở vị trí 2 — truyền `channelId` thẳng làm `channel_id` null (23502).
6. **Đột biến B2 (7/7 đỏ):** bỏ 403, bỏ 409, audit cả khi chủ, bỏ map 412, ghi `text` vào audit metadata (test kiểm chuỗi nhạy cảm không xuất hiện), policy bỏ kiểm `completed`, policy kiểm trạng thái TRƯỚC quyền. Đột biến cuối chỉ unit bắt (e2e không có ca "không quyền + meeting đang chạy"), đúng chỗ: thứ tự quyền / trạng thái là tính chất của hàm thuần.
7. **`ParseIntPipe` không đủ cho `:seq`, và `If-Match` có nhiều hình dạng hợp lệ về mặt HTTP nhưng vô nghĩa ở đây.** `seq` là cột `integer`: `ParseIntPipe` nhận số âm và số vượt int32 — số lớn xuống Postgres là lỗi `22003` → 500 thay vì 400, nên viết `ParseSegmentSeqPipe` (regex `^\d{1,10}$` + trần int32). Tương tự `parseIfMatchVersion` chặn version 0, vượt int32, rác phía sau (`"3" ; DROP`).
8. **Quy ước `If-Match`/`ETag` đã chốt.** ETag của đoạn = `"<version>"` (RFC 9110: chuỗi trong nháy); chấp nhận `3` trần cho tiện curl. Từ chối: `W/"3"` (If-Match đòi so sánh MẠNH, weak không hợp lệ), `*` và danh sách (sửa phải gắn với MỘT version cụ thể; "bất kỳ" là ghi mù — lại đúng điều 428 sinh ra để chặn). Thiếu header → 428 chứ không phải 400, vì client chưa làm gì sai về cú pháp mà là thiếu điều kiện tiên quyết.
9. **Bẫy test: supertest tạo request sớm.** `const noAuth = http().patch(...)` dựng NGOÀI lúc gọi (`http()` bind cổng tạm ngay khi tạo) rồi await muộn trong một mảng khác → `Cannot read properties of null (reading 'address')`. Tạo request ngay chỗ await.
10. **Đột biến B3 (7/8 đỏ, 1 tương đương):** bỏ throttle, bỏ `ETag`, thiếu `If-Match` thành mặc định 1, nhận weak validator, `seq` âm hợp lệ, bỏ trim, cận 5000 → 50000. Sống sót: đổi `@RequireOrgPermission('org.meeting.manage')` thành `'org.meeting.read'` — **tương đương**: cả hai quyền org trả `true` cho mọi thành viên (`organization.policy.ts`), quyền thật nằm ở `decideTranscriptEdit` trong service. Giữ `manage` để ý định rõ và route tự theo nếu sau này siết quyền org.
