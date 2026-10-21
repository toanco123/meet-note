# M6b — Chia sẻ & quyền xem meeting

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-21: ★ cho Q1–Q6)
- **Nhánh:** `m6b-meeting-sharing`
- **Ghi chú:** tách từ M6 (Q1 của [M6-pipeline.md](M6-pipeline.md)). Pipeline (whisper, tóm tắt) **hoãn** theo yêu cầu người dùng 2026-10-21; mốc này không phụ thuộc pipeline: meeting đã có từ M5 (trạng thái `queued`).
- **Tài liệu thiết kế liên quan:** [01-overview D2, D3, D16](../design/01-overview.md), [03-database `meeting_shares`, §7](../design/03-database.md), [04-authorization §2, §3](../design/04-authorization.md), [05-api Meetings, Channels](../design/05-api.md)

## Mục tiêu

Cuối mốc:

- chủ meeting **chia sẻ** meeting của mình vào 0..n kênh (là thành viên kênh từ CM trở lên), **gỡ** share; CO / CA gỡ được mọi meeting khỏi kênh của mình;
- **một điều kiện SQL dùng chung** quyết định ai xem được meeting nào (04 §3), dùng cho chi tiết, danh sách, danh sách theo kênh — và sau này cho search (M8), báo cáo (M9);
- `GET /meetings` (lọc kênh / trạng thái / khoảng thời gian, cursor), `GET /channels/:id/meetings`, `GET /meetings/:id` theo quyền xem (thay cho "chỉ chủ" của M5);
- chủ meeting **sửa** (tiêu đề, thời điểm họp) và **xoá mềm** meeting;
- mọi chỗ đổi quyền chạy song song với chia sẻ đều có race test (gỡ khỏi kênh, lưu trữ kênh, xoá meeting).

## Ngoài phạm vi

- Pipeline xử lý, transcript, tóm tắt (M6 — hoãn). `POST /meetings/:id/retry` đi cùng pipeline.
- Tìm full-text, xuất SRT/VTT (M8) — nhưng dùng chung điều kiện xem của mốc này.
- Xoá cứng meeting đã xoá mềm + xoá object trên S3 (làm cùng pipeline, khi đã có `audio_object_key`).
- Chuyển chủ meeting (kể cả meeting không chủ — xem Q2).
- Thông báo "có meeting mới trong kênh" (M10).

## Quyết định cần duyệt

| #   | Câu hỏi                                                                                                       | Đề xuất ★                                                                                                                                                                                                                       | Phương án khác                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Tài liệu lệch code:** kênh công khai **đã lưu trữ** — thành viên org ngoài kênh còn xem được meeting không? | ★ **Còn.** Lưu trữ = chỉ đọc (D3), và `channel.content.read` của M4 đã cho đọc kênh lưu trữ. Sửa 04 §3 điều 3: bỏ "chưa lưu trữ", chỉ giữ "chưa xoá". Kênh **đã xoá** → share không còn tác dụng với ai (kể cả thành viên kênh) | Theo đúng chữ 04 §3: kênh công khai lưu trữ thì chỉ thành viên kênh còn xem — khi đó phải sửa `channel.content.read` của M4 |
| Q2  | Meeting **không chủ** (chủ rời org, D16 "OrgAdm quản lý") — ai làm gì?                                        | ★ Org Owner / Admin **xem** (kể cả chưa share ở đâu), **sửa**, **xoá**, **gỡ share**. Không ai share thêm được (share đòi chủ). Chuyển chủ để mốc sau                                                                           | Không ai quản lý: meeting không chủ chỉ còn xem qua các share đang có, chưa share thì không ai thấy (mồ côi)                |
| Q3  | Share lại meeting **đã** share vào kênh đó?                                                                   | ★ **Idempotent:** lần đầu 201, lần sau 200 cùng nội dung (như complete upload ở M5). `INSERT … ON CONFLICT DO NOTHING`                                                                                                          | 409 `MEETING_ALREADY_SHARED`                                                                                                |
| Q4  | Ai gỡ được meeting khỏi kênh?                                                                                 | ★ Theo 04 §2 + 05: CO, CA gỡ mọi meeting; CM gỡ meeting của mình; **chủ meeting luôn gỡ được meeting của mình** kể cả khi đã rời kênh (dữ liệu của mình). Kênh lưu trữ → 409 `CHANNEL_ARCHIVED` cho mọi người                   | Chủ meeting đã rời kênh thì phải nhờ CO / CA gỡ                                                                             |
| Q5  | Thứ tự trong `GET /meetings`?                                                                                 | ★ `recorded_at DESC, id DESC` (thời điểm họp — cái người dùng nghĩ tới, và là cột báo cáo tuần dùng); index `(org_id, recorded_at)` đã có. `GET /channels/:id/meetings` sắp theo `shared_at DESC` (mới chia sẻ lên trước)       | `created_at` (thời điểm upload) cho cả hai                                                                                  |
| Q6  | Xoá meeting ảnh hưởng gì?                                                                                     | ★ **Xoá mềm** (`deleted_at`): biến mất với mọi người (404), share giữ nguyên nhưng không còn hiệu lực, file trên S3 giữ tới khi có purge (cùng pipeline). Upload trỏ tới meeting giữ nguyên. Không cho khôi phục                | Xoá luôn các share trong cùng transaction (khôi phục về sau sẽ mất share)                                                   |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- **Điều kiện xem** là một hàm dựng SQL trong repository (`visibleTo(userId)` trả về `EXISTS …`), không phải hàm SQL trong DB: test được, đọc được trong code, Drizzle ghép vào mọi query. Một nơi duy nhất — test kiến trúc / review chặn chỗ nào tự lọc kiểu khác.
- **Thứ tự khoá chung** thêm **bậc 4 = `meetings`** (sau `channel_members`): gỡ thành viên khỏi org đã cập nhật `meetings.owner_id` (SET NULL) SAU khi khoá `organization_members`, nên meeting phải đứng sau. Share: kênh `FOR SHARE` (bậc 2, đụng với lưu trữ / đổi quyền vốn khoá `FOR UPDATE`) → dòng `channel_members` của người share `FOR SHARE` (bậc 3) → meeting `FOR SHARE` (bậc 4) → kiểm tra lại → insert.
- Quyền mới trong `channelPolicy`: `channel.meeting.share` (CO, CA, CM), `channel.meeting.unshare` (CO, CA; CM với meeting của mình — kiểm theo đối tượng trong service). Cả hai vào `BLOCKED_WHEN_ARCHIVED`.
- **Không thêm mã lỗi mới:** share meeting của người khác → **404** (tài nguyên ẩn: không lộ meeting mình không được xem); kênh không đủ quyền → 403 / 404 như M4; kênh lưu trữ → 409 `CHANNEL_ARCHIVED`. Gặp tình huống thật cần mã riêng thì thêm vào catalog lúc làm.
- Không ghi audit cho share (thao tác nội dung, không phải quản trị). Xoá meeting **không chủ** bởi OrgAdm thì có ghi audit (`meeting.deleted`) vì là thao tác quản trị.

## Thay đổi thiết kế

### Bảng

| Bảng             | Cột                                                       | Ràng buộc / index                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meeting_shares` | meeting_id, channel_id, org_id, shared_by NULL, shared_at | PK `(meeting_id, channel_id)`; composite FK `(meeting_id, org_id)` → `meetings(id, org_id)` và `(channel_id, org_id)` → `channels(id, org_id)` (không share chéo org), cả hai ON DELETE CASCADE (purge kênh = gỡ share, D3); `shared_by` → `users` ON DELETE SET NULL; index `(channel_id, shared_at DESC, meeting_id)` |

### API (05-api), prefix `/v1/orgs/:orgId`

| Method | Path                                                    | Ai gọi                                            | Ghi chú                                                                 |
| ------ | ------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/meetings?channelId=&status=&from=&to=&cursor=&limit=` | Thành viên org                                    | Chỉ meeting xem được; `from` / `to` lọc `recorded_at`                   |
| GET    | `/meetings/:meetingId`                                  | Người xem được (04 §3)                            | Thêm `channels: [{ id, name }]` — các kênh share mà người gọi thấy được |
| PATCH  | `/meetings/:meetingId`                                  | Chủ meeting; OrgAdm nếu meeting không chủ (Q2)    | `title`, `recordedAt`                                                   |
| DELETE | `/meetings/:meetingId`                                  | như trên                                          | 204, xoá mềm (Q6)                                                       |
| POST   | `/meetings/:meetingId/shares`                           | Chủ meeting + CM+ của kênh                        | `{ channelId }` → 201 / 200 (Q3)                                        |
| DELETE | `/meetings/:meetingId/shares/:channelId`                | Chủ meeting; CO, CA; OrgAdm nếu meeting không chủ | 204; gọi lại → 204                                                      |
| GET    | `/channels/:channelId/meetings?cursor=`                 | `channel.content.read`                            | Theo `shared_at DESC`                                                   |

## Các bước

Mỗi bước = 1 commit, chạy được và có test.

- [ ] **B1 — Schema `meeting_shares` + thứ tự khoá bậc 4**
  - Việc: bảng + migration; cập nhật 03 §7 (bậc 4 `meetings`).
  - Test (integration): share chéo org bị FK chặn; purge kênh (xoá cứng) → share mất, meeting còn; xoá thành viên khỏi org → meeting còn, share còn.
- [ ] **B2 — Điều kiện xem dùng chung**
  - Việc: `visibleTo(userId)` + bảng test **toàn bộ ma trận**: chủ / thành viên kênh riêng tư được share / khách / thành viên org ngoài kênh công khai / ngoài kênh riêng tư / OrgAdm (kênh công khai, kênh riêng tư, meeting không chủ) / kênh lưu trữ / kênh đã xoá / meeting đã xoá / org khác.
  - Đột biến: bỏ từng vế (`deleted_at` của kênh, `visibility = 'public'`, điều kiện thành viên) → đúng ca tương ứng đỏ.
- [ ] **B3 — `GET /meetings/:id` theo quyền xem + `GET /meetings`**
  - Việc: thay `findOwned`; danh sách cursor `(recorded_at DESC, id DESC)` + bộ lọc; chi tiết kèm `channels`.
  - Test (e2e): ma trận người gọi → 200 / 404; phân trang không lặp / không sót khi nhiều meeting cùng `recorded_at`; lọc theo kênh không lộ meeting mà người gọi không xem được qua đường khác.
- [ ] **B4 — Share / gỡ share**
  - Việc: quyền mới trong `channelPolicy` + unit test ma trận; service theo thứ tự khoá ở trên; idempotent (Q3, Q4).
  - Test (e2e): bảng `[người gọi, hành động] → status`; kênh lưu trữ → 409; meeting của người khác → 404.
  - **Race** (`interleave`): share ‖ người share bị gỡ khỏi kênh → không có share nào của người đã bị gỡ được commit; share ‖ lưu trữ kênh → share trước hoặc 409; share ‖ xoá meeting → không có share mới trên meeting đã xoá. Đột biến bỏ từng khoá → đỏ.
- [ ] **B5 — `GET /channels/:channelId/meetings`**
  - Việc: qua `ChannelAccessGuard` (`channel.content.read`), cursor `(shared_at DESC, meeting_id)`.
  - Test (e2e): OrgAdm + kênh riêng tư → 403 / 404 như M4; meeting đã xoá không hiện.
- [ ] **B6 — Sửa / xoá meeting**
  - Việc: PATCH / DELETE (Q2, Q6), audit khi OrgAdm xoá meeting không chủ.
  - Test (e2e): chủ / OrgAdm (meeting có chủ → 404, không chủ → được) / người khác → 404; sau xoá: chi tiết 404, mất khỏi mọi danh sách.
- [ ] **B7 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu bằng script, smoke test trên Compose (2 người, kênh công khai + riêng tư, share / gỡ / lưu trữ / xoá), ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI; mọi chỗ khoá đã được đột biến
- [ ] Một điều kiện xem duy nhất, ma trận 04 §3 được test đầy đủ
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code (03, 04, 05, 10)

## Điều sẽ học

- Gom điều kiện phân quyền phức tạp vào **một** biểu thức SQL dùng lại (`EXISTS` lồng nhau) và test nó như một ma trận
- Keyset pagination trên điều kiện có `EXISTS`, kiểm `EXPLAIN` để không quét cả bảng
- Mở rộng thứ tự khoá chung khi có thêm loại dòng (bậc 4), race giữa "dùng quyền" và "mất quyền"
- `FOR SHARE` vs `FOR UPDATE`: nhiều người share song song không chặn nhau, nhưng chặn được lưu trữ / gỡ quyền

## Điều học được / bẫy gặp phải

(Ghi trong lúc làm)
