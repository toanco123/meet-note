# M4 — Kênh

- **Trạng thái:** **Xong ở local** (2026-10-14): B1–B8, kể cả các bước thêm theo yêu cầu (B4b–B4e). CI chạy khi push / mở PR. Plan đã duyệt 2026-10-14 (★ cho Q1, Q2, Q4; Q3 theo người dùng; Q5–Q7 ★)
- **Nhánh:** `m4-channels`
- **Tài liệu thiết kế liên quan:** [01-overview D2, D3](../design/01-overview.md), [03-database §3, §7](../design/03-database.md), [04-authorization §2, §4](../design/04-authorization.md), [05-api Channels](../design/05-api.md), [06-flows §3](../design/06-flows.md)

## Mục tiêu

Cuối mốc, trong một tổ chức:

- Thành viên tạo được **kênh công khai / riêng tư** và trở thành **Chủ kênh**.
- Kênh có 4 vai trò: Chủ kênh (CO) / QTV kênh (CA) / Thành viên (CM) / Khách (G).
- Quản lý thành viên kênh: thêm, đổi vai trò, gỡ. Thành viên tự join kênh công khai và tự rời kênh.
- **Chuyển chủ kênh**, lưu trữ (chỉ đọc), xoá mềm, cùng **logic dọn dẹp** kênh đã xoá quá 30 ngày.
- **Kênh riêng tư trả 404** với người ngoài. Org Owner/Admin thấy metadata nhưng không thấy nội dung.
- **Ma trận quyền kênh pass toàn bộ e2e dạng bảng.**

Đồng thời đóng hai việc treo:

1. **Gỡ / rời tổ chức** (M2, M3) phải **bị chặn khi người đó còn làm chủ kênh** (Q3). Nếu không, composite FK `ON DELETE CASCADE` sẽ xoá luôn dòng chủ kênh → kênh mồ côi.
2. **Xoá tổ chức** (đã hoãn ở M2 Q2).

## Ngoài phạm vi

- Meeting trong kênh, chia sẻ meeting (M6), báo cáo tuần (M9). Cột `weekly_report_enabled` tạo sẵn để dùng ở M9.
- **Lên lịch** chạy job dọn dẹp (xem Q1).
- Dọn dẹp (xoá cứng) tổ chức đã xoá mềm.

## Quyết định cần duyệt

| #   | Câu hỏi                                           | Đề xuất ★                                                                                                                                                                                                                                                                                               | Phương án khác                                                     |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Q1  | Job dọn dẹp kênh đã xoá mềm chạy thế nào?         | ★ **M4 viết logic dọn dẹp** (`FOR UPDATE SKIP LOCKED` theo lô) **+ test đồng thời**. **Lên lịch chạy ở M6**, khi worker có BullMQ processor thật. Tránh dựng tạm `@nestjs/schedule` rồi lại bỏ                                                                                                          | Lên lịch ngay bằng `@nestjs/schedule` + advisory lock trong worker |
| Q2  | Xoá tổ chức                                       | ★ **Làm ở M4**, chỉ **xoá mềm**, chỉ Owner, có audit. Guard đã lọc org xoá mềm nên mọi kênh/route bên trong tự 404. Xoá cứng để sau                                                                                                                                                                     | Tiếp tục hoãn                                                      |
| Q3  | Chủ kênh bị gỡ / rời tổ chức thì ai làm chủ kênh? | **ĐÃ CHỐT (theo người dùng):** **phải chuyển chủ kênh trước**, giống Owner tổ chức phải chuyển quyền sở hữu trước khi rời. Rời / bị gỡ khỏi org khi còn làm chủ kênh → 409 `ORG_MEMBER_OWNS_CHANNELS`, kèm danh sách kênh. Muốn gỡ người đó thì OrgAdm chuyển chủ kênh hộ trước (quyền override có sẵn) | ~~Tự chọn người kế nhiệm (QTV → thành viên → Owner org)~~: bỏ      |
| Q4  | Danh sách kênh sắp xếp thế nào?                   | ★ **Theo tên A→Z**: keyset trên `lower(name)` (B3: bỏ `id` vì index unique, xem bài học 4), dùng lại unique index `(org_id, lower(name)) WHERE deleted_at IS NULL`. Học thêm cursor trên **biểu thức**                                                                                                  | Mới nhất trước theo `created_at`                                   |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- Kênh đã lưu trữ vẫn cho **rời kênh** (không ai bị kẹt). Mọi thao tác ghi khác trả 409 `CHANNEL_ARCHIVED`, trừ bỏ lưu trữ và xoá.
- Thêm vào kênh một người **không phải thành viên tổ chức** → 404.

## Phát hiện khi lập plan: cần **thứ tự khoá chung** cho cả hệ thống

M4 là mốc đầu tiên có thao tác khoá **hai loại bảng**:

- **Gỡ khỏi tổ chức** khoá `organization_members` rồi mới khoá các kênh người đó làm chủ.
- **OrgAdm chuyển chủ kênh** khoá kênh, rồi kiểm tra vai trò tổ chức của chính mình.

Nếu mỗi thao tác khoá theo một thứ tự riêng, hai thao tác này có thể **chờ nhau vòng tròn** → Postgres phát hiện deadlock (`40P01`) và giết một bên.

**Quy tắc mới (ghi vào `03-database.md` §7), mọi thao tác khoá đều theo đúng thứ tự:**

1. `organization_members` (theo `user_id`)
2. `channels` (theo `id`)
3. `channel_members` (theo `user_id`)

Ví dụ: OrgAdm chuyển chủ kênh phải khoá vai trò tổ chức của mình (`FOR SHARE`) **trước** khi khoá dòng kênh. Một test sẽ chạy hai thao tác này song song. **Đột biến** đảo thứ tự khoá phải sinh lỗi `40P01`.

## Thay đổi thiết kế

### Bảng (sửa `03-database.md` §3)

Đúng như thiết kế, đặt tên constraint theo quy ước:

| Bảng              | Cột chính                                                                                                                     | Ràng buộc / index                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`        | id, org_id, name, description, visibility, weekly_report_enabled, created_by, archived_at, deleted_at, created_at, updated_at | `channels_id_org_uq UNIQUE (id, org_id)` (đích composite FK)<br>`channels_org_name_uq UNIQUE (org_id, lower(name)) WHERE deleted_at IS NULL`<br>index purge `(deleted_at) WHERE deleted_at IS NOT NULL`<br>CHECK visibility, CHECK độ dài tên 1–80                                                                |
| `channel_members` | channel_id, org_id, user_id, role, joined_at                                                                                  | PK `(channel_id, user_id)`<br>FK `(channel_id, org_id)` → `channels(id, org_id)` CASCADE<br>**FK `(org_id, user_id)` → `organization_members` CASCADE** (người ngoài org không vào được kênh; rời org thì tự rời kênh)<br>`channel_members_one_owner_uq`<br>index `(user_id)`, `(channel_id, joined_at, user_id)` |

### API (sửa `05-api.md`)

Prefix `/v1/orgs/:orgId/channels`:

| Method         | Path                                   | Ai gọi                                                                                                     |
| -------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST           | `/`                                    | Thành viên org (thành CO)                                                                                  |
| GET            | `/?q=&visibility=&archived=&cursor=`   | Thành viên org. Chỉ kênh thấy được: công khai, kênh mình là thành viên, OrgAdm thấy mọi kênh. Theo tên A→Z |
| GET            | `/:channelId`                          | Người thấy được kênh. Có `myRole`                                                                          |
| PATCH          | `/:channelId`                          | CO, CA: tên, mô tả, visibility, `weeklyReportEnabled`                                                      |
| POST           | `/:channelId/archive` · `/unarchive`   | CO, OrgAdm                                                                                                 |
| DELETE         | `/:channelId`                          | CO, OrgAdm (xoá mềm)                                                                                       |
| POST           | `/:channelId/join` · `/leave`          | join: thành viên org, kênh công khai; leave: mọi thành viên kênh, CO → 409                                 |
| GET            | `/:channelId/members?q=&role=&cursor=` | CO, CA, CM, ngoài (pub), OrgAdm. Khách → 403                                                               |
| POST           | `/:channelId/members`                  | CO, CA (`{ userId, role }`). CA chỉ thêm member/guest                                                      |
| PATCH / DELETE | `/:channelId/members/:userId`          | CO, CA (giới hạn theo ma trận)                                                                             |
| POST           | `/:channelId/ownership-transfer`       | CO, OrgAdm (`{ newOwnerId }`, người nhận phải là thành viên kênh, không phải Khách)                        |

Và `DELETE /v1/orgs/:orgId` (Owner, xoá mềm) theo Q2.

### Quyền (bổ sung `04-authorization.md` §2, §4)

- **`ChannelAccessGuard`:**
  - `:channelId` không phải uuid / không có trong org / đã xoá → 404.
  - Kênh riêng tư mà người gọi không phải thành viên kênh và không phải OrgAdm → **404**.
  - Gắn `req.channelAccess = { channel, channelRole | null, orgRole }`.
- **`@RequireChannelPermission(p)`:** gộp `OrgMemberGuard → ChannelAccessGuard → ChannelPermissionGuard` + Swagger, cùng mẫu với `@RequireOrgPermission`.
- **`channel.policy.ts`:** permission theo đúng ma trận §2, kèm các hàm kiểm tra theo đối tượng:
  - `canGrantChannelRole`: CA chỉ cấp member/guest;
  - `canChangeChannelRole`;
  - `canRemoveChannelMember`;
  - người nhận chủ kênh không được là Khách.
- **Kênh lưu trữ:** guard trả 409 nhanh cho các permission "ghi". Service **kiểm tra lại sau khi khoá dòng kênh** (lưu trữ có thể xảy ra giữa chừng).

### Mã lỗi mới

| Mã                                | HTTP                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `CHANNEL_NAME_TAKEN`              | 409, map từ `channels_org_name_uq`                                              |
| `CHANNEL_ARCHIVED`                | 409                                                                             |
| `CHANNEL_ALREADY_MEMBER`          | 409                                                                             |
| `CHANNEL_OWNER_IMMUTABLE`         | 409                                                                             |
| `CHANNEL_OWNER_MUST_TRANSFER`     | 409                                                                             |
| `CHANNEL_TRANSFER_INVALID_TARGET` | 409: chuyển cho chính mình / cho Khách                                          |
| `ORG_MEMBER_OWNS_CHANNELS`        | 409: rời / bị gỡ khỏi org khi còn làm chủ kênh (Q3), `details` liệt kê các kênh |

## Dependency mới

Không có.

## Các bước

Mỗi bước = 1 commit, chạy được và có test. Mỗi chỗ khoá đều có test race + đột biến.

- [x] **B1 — Schema + migration**
  - Việc: `channels`, `channel_members`, composite FK, partial unique.
  - Test (integration):
    - thêm người **ngoài org** vào kênh → 23503 (composite FK);
    - kênh org A không chứa được membership ghi org B;
    - xoá org membership → tự rời mọi kênh;
    - tên trùng không phân biệt hoa thường → 23505, xoá mềm rồi thì dùng lại được tên.
- [x] **B2 — Policy kênh (thuần)**
  - Việc: permission theo ma trận §2 + 3 hàm theo đối tượng.
  - Test (unit): bảng phủ **toàn bộ** ma trận × 6 kiểu người gọi (CO/CA/CM/G/ngoài-pub/OrgAdm) × công khai/riêng tư; test "bảng phủ đủ permission".
- [x] **B3 — Guard + tạo / liệt kê / xem / sửa kênh**
  - Việc: `ChannelAccessGuard`, `@RequireChannelPermission`, CRUD có audit, danh sách theo tên (keyset trên biểu thức, Q4).
  - Test (e2e):
    - kênh riêng tư → người ngoài 404, OrgAdm thấy metadata;
    - danh sách lọc đúng theo quyền thấy;
    - tên trùng → 409;
    - phân trang theo tên không trùng/sót.
- [x] **B4 — Thành viên kênh**
  - Việc: liệt kê (cursor + tìm không dấu), thêm, đổi vai trò, gỡ. Mọi thao tác khoá **dòng kênh trước** (mutex) rồi mới khoá dòng thành viên.
  - Test (e2e): bảng phân quyền đầy đủ; Khách xem danh sách → 403.
  - **Race:** lưu trữ kênh ‖ thêm thành viên → không bao giờ "thêm thành công vào kênh đã lưu trữ". Đột biến bỏ kiểm tra lại sau khoá → đỏ.
- [x] **B4b — Gom thông điệp lỗi vào một catalog** (thêm theo yêu cầu người dùng sau B4)
  - Việc: `src/common/errors/errors.ts` gồm các hàm tạo lỗi chia theo domain (`Errors.channel.archived()`…). Chuyển toàn bộ chỗ tạo `AppException` ở M1–M4 sang dùng catalog, viết lại các câu cùng ý mà đang lệch nhau. Không đổi `code` hay HTTP status.
  - Test (unit): test kiến trúc quét `src/`, phát hiện tạo `AppException` ngoài catalog thì đỏ. Toàn bộ unit + e2e cũ vẫn xanh.
- [x] **B4c — Gom interface / type viết tay vào `<module>.types.ts`** (thêm theo yêu cầu người dùng sau B4b)
  - Việc: mỗi module (và mỗi nhóm trong `common/`) có một file `*.types.ts` chứa mọi interface/type viết tay được export, kể cả `declare global` mở rộng `Express.Request`. Kiểu suy ra từ giá trị (`typeof`, `$inferSelect`, cặp const/type cùng tên) để cạnh giá trị gốc. Kiểu nội bộ không export để tại chỗ. Không đổi hành vi.
  - Test (unit): test kiến trúc. Ngoài `*.types.ts` không có `export interface`, và không có `export type` viết tay. Trong `*.types.ts` không có giá trị runtime.
- [x] **B4d — Thư mục theo vai trò + cập nhật README** (thêm theo yêu cầu người dùng sau B4c)
  - Việc: thư mục nào có ≥ 2 file cùng vai trò (`*.service.ts`, `*.repository.ts`, `*.controller.ts`, `*.types.ts`) thì gom vào `services/`, `repositories/`, `controllers/`, `types/`. Test gắn với một file cụ thể dời theo, để `test/` vẫn mô phỏng `src/`. README tổng hợp lại cấu trúc + quy ước. Không đổi hành vi.
  - Test (unit): test kiến trúc. Không thư mục nào có ≥ 2 file cùng vai trò nằm lẫn; thư mục vai trò chỉ chứa đúng vai trò đó.
- [x] **B5 — Join / leave + chuyển chủ kênh**
  - Việc: theo `06-flows.md` §3, áp **thứ tự khoá chung**.
  - Test (e2e): CO rời → 409; chuyển cho Khách → 409; OrgAdm chuyển hộ được.
  - **Race (đổi khi làm B5, xem bài học 15):** gỡ X khỏi org ‖ chuyển chủ kênh cho X, ép thứ tự "gỡ khoá dòng org của X trước". Đúng thứ tự khoá → không deadlock, chuyển nhận 404. **Đột biến đảo thứ tự khoá (kênh → thành viên kênh → org) → `40P01`.** Kịch bản ban đầu "OrgAdm chuyển ‖ Owner gỡ chính OrgAdm" không thể tạo vòng chờ, nên không chứng minh được gì.
  - **Race:** CO chuyển cho X ‖ X rời kênh → không bao giờ "X rời mà vẫn thành chủ" (kênh mất chủ). Hai transfer song song tới 2 người → đúng 1 chủ.
- [x] **B4e — Envelope `{ data, meta }` cho mọi response thành công** (theo yêu cầu người dùng sau B5; Q5–Q7 đã chốt ★, thêm `statusCode` theo yêu cầu)
  - Hình dạng (đề xuất ★, xem câu hỏi Q5–Q7 bên dưới):
    - Một tài nguyên: `{ "data": { … }, "meta": { "statusCode": 200, "requestId": "…" } }`
    - Danh sách: `{ "data": [ … ], "meta": { "statusCode": 200, "requestId": "…", "nextCursor": "…" | null } }`
    - Lỗi: giữ vỏ `{ "error": { code, statusCode, message, details, requestId } }` (thêm `statusCode`)
    - `204` vẫn không có body. `/health/*` giữ dạng thô (probe của Docker/K8s, quy ước chung).
  - Cách làm:
    - **Một interceptor toàn cục** `ResponseEnvelopeInterceptor` (đăng ký trong `configureApp`, e2e dùng chung) bọc kết quả của handler. Service và controller **không đổi**: vẫn trả DTO / `Page<T>`. Envelope chỉ là việc của ranh giới HTTP.
    - Danh sách được nhận biết bằng metadata do `@ApiPaginatedResponse` gắn (đã có trên mọi route danh sách), không đoán theo shape. `@RawResponse()` để thoát envelope (health).
    - **Swagger:** biến đổi document một chỗ trong `buildOpenApiDocument`. Mọi response 2xx JSON được bọc thành `{ data: <schema cũ>, meta: ResponseMetaDto | PaginatedMetaDto }`, dựa trên đúng các đánh dấu interceptor dùng (`x-paginated`, `x-raw-response`). Runtime và tài liệu cùng một nguồn quyết định.
  - Test:
    - e2e: một tài nguyên, danh sách, `meta.requestId` = header `x-request-id`; health giữ dạng thô; 204 không body; lỗi giữ nguyên.
    - test kiến trúc trên `openapi.json`: mọi response 2xx JSON (trừ raw) có `data` + `meta`.
    - Cập nhật toàn bộ e2e cũ (`res.body.x` → `res.body.data.x`, `nextCursor` → `meta.nextCursor`).
  - Tài liệu: 07 §3, 05-api (ghi chú chung), README, `openapi.json`.

| #   | Câu hỏi (B4e)                         | Đề xuất ★                                                                              | Phương án khác                                |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------- |
| Q5  | `meta` của một tài nguyên chứa gì?    | ★ `{ requestId }`: đối xứng với lỗi (lỗi đã có `requestId`), `meta` không bao giờ rỗng | `meta: {}`                                    |
| Q6  | `nextCursor` của danh sách đặt ở đâu? | ★ Trong `meta`: `meta.nextCursor`. `data` luôn là dữ liệu thuần                        | Giữ `nextCursor` ở cấp ngoài cùng cạnh `data` |
| Q7  | Lỗi có đổi theo không?                | ★ Giữ `{ error }`: có `data` là thành công, có `error` là lỗi, không cần cờ `success`  | `{ error, meta }` cho đối xứng hoàn toàn      |

- [x] **B6 — Lưu trữ / bỏ lưu trữ / xoá mềm + logic dọn dẹp**
  - Việc: lưu trữ chặn ghi (409); xoá mềm thì 404 với mọi người, tên dùng lại được; `purgeBatch` dùng `FOR UPDATE SKIP LOCKED`.
  - **Test xác định (không phụ thuộc thời gian):** transaction A giữ khoá 5 kênh, transaction B (đặt `lock_timeout`) phải lấy ngay 5 kênh **khác**. Đột biến bỏ `SKIP LOCKED` → B lỗi `55P03` (hết thời gian chờ khoá).
- [x] **B7 — Chặn rời / gỡ khỏi tổ chức khi còn làm chủ kênh + xoá tổ chức**
  - Việc:
    - `remove` / `leave` của tổ chức kiểm tra người đó còn làm chủ kênh nào (chưa xoá) → 409 `ORG_MEMBER_OWNS_CHANNELS` kèm danh sách kênh (Q3);
      - lưu ý từ B6: kênh **đã xoá mềm** vẫn còn dòng chủ kênh tới khi bị dọn (30 ngày). Không được tính, nếu không người đó sẽ bị chặn rời org vì một kênh không ai thấy;
    - `DELETE /v1/orgs/:orgId` (Q2).
  - **Race phải chặn:** Admin gỡ X ‖ chủ kênh chuyển kênh cho X. Không phối hợp khoá thì: gỡ kiểm tra "X không làm chủ kênh nào" → chuyển kênh commit → gỡ xoá membership của X → cascade xoá dòng chủ kênh → **kênh mất chủ**.
    - Cách chặn bằng thứ tự khoá chung: chuyển chủ kênh khoá `FOR SHARE` dòng thành viên tổ chức của **người nhận** (bậc 1) trước khi khoá kênh; gỡ khoá `FOR UPDATE` cùng dòng đó. Kết quả là hai thao tác chạy tuần tự.
    - Ai trước cũng ra kết cục hợp lệ: chuyển trước → gỡ thấy X làm chủ → 409; gỡ trước → chuyển thấy X không còn trong org → 404.
  - Test (integration): race trên → không bao giờ có kênh mất chủ. **Đã làm xác định cho CẢ HAI thứ tự** (thay cho 10 vòng ngẫu nhiên, xem bài học 24). **Đột biến** bỏ khoá dòng thành viên tổ chức của người nhận → kênh mất chủ (đỏ).
  - Test (e2e): chủ kênh rời org → 409 kèm tên kênh; chuyển chủ kênh xong thì rời được; Owner org xoá org → mọi route bên trong 404.
- [x] **B8 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu, chạy tay trên Docker Compose, ghi "Điều học được".

## Tiêu chí hoàn thành

- [x] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh (unit 324)
- [x] `pnpm test:e2e` xanh ở local (371); các race test + test `SKIP LOCKED` đều đã được đột biến (kết quả ở bài học 6, 9–10, 15–16, 21, 24)
- [ ] `pnpm test:e2e` xanh ở CI: chờ push / PR
- [x] Ma trận quyền kênh (§2) pass toàn bộ ở unit (12 permission × 6 kiểu người gọi × công khai/riêng tư) và e2e dạng bảng
- [x] Không còn đường nào để kênh mất chủ (gỡ / rời / chuyển), kể cả khi các thao tác chạy song song: chủ kênh rời kênh → 409; chuyển ‖ rời kênh (B5); gỡ / rời org khi còn làm chủ → 409, gỡ ‖ chuyển cả hai thứ tự (B7). Mỗi đường đều có đột biến cho ra "kênh mất chủ"
- [x] `docs/design/` khớp với code (đối chiếu route 05-api ↔ `openapi.json` và mã lỗi 07 ↔ `ErrorCode` bằng script), có **thứ tự khoá chung** trong §7 (bậc 0–3)

## Điều sẽ học

- Composite FK để ép nhất quán tenant ngay ở DB, và mặt trái của `ON DELETE CASCADE`
- Dòng cha làm mutex (`FOR UPDATE` dòng kênh) + kiểm tra lại sau khi khoá
- Thứ tự khoá toàn cục để tránh deadlock, và cách chứng minh deadlock bằng test
- `FOR UPDATE SKIP LOCKED` cho nhiều worker cùng lấy việc; test xác định bằng hai transaction + `lock_timeout`
- Keyset cursor trên **biểu thức** (`lower(name)`) + partial unique index
- Guard nhiều tầng thứ hai (kênh nằm trong org): 404 vs 403, metadata vs nội dung

## Điều học được / bẫy gặp phải

1. **Hai composite FK trên `channel_members` chặn hai loại lỗi khác nhau.** `(channel_id, org_id)` chặn ghi membership "của org B" vào kênh org A. `(org_id, user_id)` chặn người ngoài org vào kênh. Cả hai đã kiểm bằng integration test, mỗi lỗi ra **đúng tên constraint**.
2. **Composite FK cần một unique ở bảng cha trùng đúng bộ cột**: `channels_id_org_uq (id, org_id)`, dù `id` đã là PK. Còn `organization_members` có sẵn PK `(org_id, user_id)` nên dùng luôn được.
3. **Test "mặt trái của cascade" đặt ngay ở B1:** xoá người khỏi org thì DB tự xoá luôn dòng chủ kênh, kênh mất chủ. Test này ghi lại hành vi của DB để B7 chặn ở tầng service.
4. **Keyset trên biểu thức không cần tie-breaker khi biểu thức đã unique.** Plan ban đầu ghi `(lower(name), id)`. Nhưng `channels_org_name_uq` bảo đảm `lower(name)` không trùng trong đúng tập danh sách duyệt (cùng org, chưa xoá), nên cursor chỉ cần một khoá. Lúc đó `lower(name) > $1` khớp thẳng index, EXPLAIN cho thấy Index Scan, không có Sort (test integration). `ORDER BY name` lệch biểu thức thì phải Sort. Khoá cursor lấy `lower(name)` **do Postgres tính**, không dùng `toLowerCase()` của JS, vì hai bên có thể lower khác nhau với vài ký tự Unicode.
5. **Image `postgres:18.6-alpine` (musl): `en_US.utf8` thực chất so theo byte.** Đo trực tiếp: `'B' < 'b'`, `'é' > 'f'`, trong khi `lower('KỸ THUẬT Đ')` vẫn ra đúng `kỹ thuật đ`. Vì vậy "trùng tên không phân biệt hoa thường" vẫn đúng với tiếng Việt, còn **thứ tự A→Z phụ thuộc libc của image** (glibc sắp theo ngôn ngữ). Keyset không sai, vì index và phép `>` dùng cùng collation. Nhưng đổi image hoặc libc thì thứ tự đổi, và index trên text phải REINDEX. Test phân trang cố ý dùng tên ASCII để không phụ thuộc collation.
6. **"Kiểm tra lại sau khi khoá" chỉ chứng minh được bằng race có điều khiển thứ tự.** E2E không chạm được nhánh này, vì guard chặn trước. Test `channel-update-race` để T1 giữ khoá dòng kênh và đổi trạng thái (lưu trữ / hạ QTV), rồi chờ T2 (`service.update`) **thực sự đợi khoá** bằng `waitForLockWaiters` (hỏi `pg_stat_activity.wait_event_type = 'Lock'`), không dùng sleep, xong mới commit T1. Đột biến bỏ kiểm tra lại → 2 test đỏ (`expected 'OK' to be 'CHANNEL_ARCHIVED'` / `'FORBIDDEN'`). Có thêm case đối chứng "T1 không đổi gì → OK" để chắc rằng khung test không phải lúc nào cũng từ chối.
7. **Đột biến guard kênh:** bỏ lọc `org_id` trong `findAccess` → test "kênh org khác gắn vào path org này" đỏ (đúng lỗ IDOR). Bỏ kiểm tra `channel.read` → 3 test "riêng tư → 404" đỏ.
8. **Query param có giá trị mặc định bị Swagger ghi là bắt buộc.** `limit: number = 20` (từ M2) và `archived: boolean = false` không có `?`, nên CLI plugin đánh dấu `required: true`, và client sinh từ spec sẽ bắt truyền. Lỗi này nằm im từ M2, đến khi đọc lại `openapi.json` của B3 mới thấy. Cách sửa: thêm `@ApiPropertyOptional()`. Plugin vẫn giữ `default`/`min`/`max`, `openapi.json` đổi ở cả 5 danh sách.
9. **Dòng kênh là mutex, nhưng chưa đủ: cascade đi vòng qua nó.** Gỡ X khỏi tổ chức xoá dòng `channel_members` của X bằng `ON DELETE CASCADE`, không khoá dòng kênh. Vì vậy đổi vai trò / gỡ trong kênh vẫn phải khoá `FOR UPDATE` dòng thành viên đích (bậc 3). Đột biến bỏ khoá này cho ra `NOT_FOUND/1`: response vẫn 404 (đọc lại sau commit không thấy), nhưng UPDATE đã trúng **0 dòng mà không báo lỗi**, và audit đã ghi "đổi vai trò" cho một thay đổi không xảy ra. Bẫy này chỉ lộ ra khi test kiểm tra cả audit, không chỉ kiểm tra status.
10. **Khoá `FOR SHARE` dòng tổ chức trước khi thêm vào kênh (bậc 1) cho ra lỗi đúng nghĩa.** Bỏ khoá này thì dữ liệu vẫn nhất quán, vì composite FK chặn được. Nhưng INSERT phải đợi ở bước kiểm tra FK rồi nổ `23503`, và lỗi Postgres lọt ra thay vì 404 "không phải thành viên tổ chức". Đây đúng là câu trong plan: "ràng buộc DB là lưới an toàn, khoá cho ra ngữ nghĩa lỗi đúng".
11. **Gom khung race thành helper `runWhileLocked` + `lockChannelThen`** (`test/support/locks.ts`). Mỗi race test giờ chỉ còn 3 phần: T1 làm gì, T2 gọi gì, kết quả mong đợi. Kết quả gộp thành một chuỗi `outcome/trạng-thái-DB` (vd `CHANNEL_ARCHIVED/gone`), nên khi đỏ, thông báo lỗi cho biết ngay đột biến đã làm hỏng ở đâu.
12. **Gom text lỗi về catalog `Errors` (B4b) lộ ra sự không nhất quán khó thấy khi text còn rải rác.** Trước khi gom có khoảng 45 chỗ tạo lỗi trong 15 file. `'Không tìm thấy tổ chức.'` bị gõ lại 7 lần. Cùng ý "cấp vai trò ngang/cao hơn mình" có 3 câu khác nhau. Câu `'Không tìm thấy link mời.'` đi với **hai code khác nhau** (`NOT_FOUND` khi admin thu hồi, `INVITE_NOT_FOUND` khi mở link), nên catalog tách thành `invite.notFound` và `invite.tokenNotFound` để giữ nguyên code. Catalog tra theo tình huống chứ không theo `code`, vì `NOT_FOUND` có nhiều câu. Mỗi mục là hàm để stack trace đúng chỗ ném. Bỏ hẳn `AppException.notFound/forbidden/conflict` (dùng lại là lỗi compile). `new AppException(` thì kiểu không chặn được, nên có test kiến trúc quét `src/` (bỏ qua comment). Đột biến chèn `new AppException(` hoặc `throw new NotFoundException(` vào `me.service.ts` → đỏ, kèm tên file vi phạm. Câu chữ được thống nhất lại, còn `code` và HTTP status giữ nguyên, toàn bộ e2e cũ vẫn xanh.
13. **Gom type (B4c) cũng lộ ra vấn đề ẩn.** Có hai `ChannelMemberRow` khác nhau: một suy ra từ schema (`$inferSelect`), một là row danh sách trong repository (có tên/email). Hai cái chỉ chưa đụng nhau vì nằm ở hai file. Bản trong repository đã đổi tên thành `ChannelMemberListRow`. Còn `audit.types.ts` thì đang chứa giá trị runtime (`AUDIT_ACTIONS`); hằng này cùng `AuditAction` đã tách sang `audit-actions.ts`. **Không chuyển mọi thứ:** kiểu suy ra (`typeof`, cặp const/type như `OrgRole`) phải đứng cạnh giá trị, và kiểu nội bộ không export thì để tại chỗ. Việc chuyển làm bằng codemod Python (cắt khối khai báo, sửa import ở cả `src/` và `test/`). Một lần dùng regex `.*?;\n` để cắt interface đã cắt trúng dấu `;` của property đầu tiên và làm hỏng file. Cắt khối code phải đếm ngoặc, không dùng regex non-greedy. Test kiến trúc `types-location.spec.ts` đã thử 3 đột biến (`export interface` / `export type` viết tay trong service, hằng trong file types), cả 3 đều đỏ.
14. **Dời 26 file vào thư mục vai trò (B4d) bằng codemod tính lại MỌI import tương đối.** Mỗi specifier được resolve theo vị trí CŨ của file đang import, ánh xạ qua bảng dời, rồi tính lại theo vị trí MỚI. Cần làm cả hai chiều: file bị dời import file khác, và file khác import file bị dời. Dùng `git mv` để giữ lịch sử. Sau khi dời: typecheck sạch, `openapi.json` không đổi (`operationId` dựa trên tên class, không dựa trên đường dẫn). Có 3 chỗ ghi đường dẫn cũ dạng chữ (08-testing, một comment, skill testing) mà compiler không bắt được, phải grep. Quy tắc nằm trong CLAUDE.md để áp dụng khi tạo file mới, kèm test kiến trúc `folder-layout.spec.ts` (đột biến: thêm service thứ 2 nằm lẫn ở `me/` → đỏ; đặt repository vào `services/` → đỏ). Theo yêu cầu người dùng, **không sửa skill**: skill `testing` còn ví dụ đường dẫn cũ của `token.service.spec.ts`.
15. **Muốn chứng minh deadlock thì phải có một VÒNG chờ, và phải chọn đúng kịch bản.** Race ban đầu trong plan, "OrgAdm chuyển chủ kênh ‖ Owner gỡ chính OrgAdm đó", không thể deadlock. Gỡ OrgAdm chỉ chạm dòng tổ chức và các dòng kênh _của OrgAdm_, còn chuyển chủ kênh giữ dòng kênh và dòng của _chủ cũ + người nhận_. Hai bên không giữ thứ gì của nhau, nên đảo thứ tự khoá cũng không sinh `40P01`. Kịch bản đúng là **gỡ X khỏi org ‖ chuyển chủ kênh cho X**: phía gỡ giữ dòng org của X, rồi cascade cần dòng `channel_members` của X; phía chuyển, nếu khoá sai thứ tự, giữ dòng `channel_members` của X rồi chờ dòng org của X. Test ép thứ tự bằng `interleave`: T1 khoá dòng org của X → T2 (chuyển chủ) chạy tới khi đợi khoá → T1 xoá (`afterWait`). Đúng thứ tự → `OK/NOT_FOUND`. Đột biến đưa bậc 1 xuống cuối → `OK/pg:40P01` sau 1076 ms, đúng `deadlock_timeout` 1 giây. Postgres chọn **bên chờ trước** (chuyển chủ kênh) làm nạn nhân, vì bộ phát hiện deadlock chạy ở tiến trình nào hết `deadlock_timeout` trước. Sơ đồ cũ ở 06-flows §3 cũng khoá kênh trước và thiếu bậc 1, tức đúng thứ tự sai mà đột biến vừa chứng minh. Đã sửa sơ đồ.
16. **Race "CO chuyển cho X ‖ X rời kênh"**: T1 giữ khoá kênh, hạ CO, nâng X. Đúng → X rời nhận 409 `CHANNEL_OWNER_MUST_TRANSFER`, X vẫn là chủ. Đột biến `leave` đọc vai trò không khoá → `OK/`: X rời thành công **và kênh không còn chủ nào**. Lý do: DELETE đợi khoá dòng rồi vẫn xoá, vì `WHERE (channel_id, user_id)` không xét vai trò mới.
17. **`outcomeOf` giờ trả `pg:<SQLSTATE>` cho lỗi Postgres lọt ra** (trước đó trả nguyên câu "Failed query: …"). Nhờ vậy assert đỏ đọc ra ngay `pg:40P01` / `pg:23503`. Lint `unicorn/no-thenable` bắt được key `then` trong object truyền cho helper: object như vậy bị coi là thenable, lỡ `await` thì JS tự gọi `then`. Đã đổi tên thành `afterWait`.
18. **`channel.join` cho thành viên gọi được (service trả 409)**, giống `channel.leave` với Chủ kênh. Nếu giữ policy "chỉ người ngoài", thành viên gọi join sẽ nhận 403 khó hiểu thay vì 409 "đã ở trong kênh" như 05-api ghi. Ma trận 04 §2 và bảng unit test đã đổi theo.
19. **Envelope `{ data, meta }` (B4e): bọc ở MỘT chỗ cho runtime, MỘT chỗ cho Swagger, cùng dựa trên một bộ đánh dấu.** `ResponseEnvelopeInterceptor` đọc metadata (`@ApiPaginatedResponse` → danh sách, `@RawResponse()` → bỏ qua), còn `applyResponseEnvelope` đọc extension tương ứng (`x-paginated`, `x-raw-response`) trên document. Danh sách được nhận biết bằng **đánh dấu**, không đoán theo shape: DTO nào tình cờ có field `data` sẽ bị hiểu nhầm. Service và controller không đổi dòng nào. `statusCode` trong body **đọc từ `res.statusCode`**, không gán cứng, vì Nest đặt status (`@HttpCode`, POST mặc định 201) TRƯỚC khi interceptor chạy. e2e kiểm tra tạo mới → `meta.statusCode` = 201, lỗi 409 → `error.statusCode` = 409. Đổi cũ sang mới trong e2e có **hai bẫy codemod**: (1) Prettier ngắt `.body` và `.id` ra hai dòng nên regex theo dòng bỏ sót (2 file lỗi ngay ở `beforeAll`, org id `undefined` → 23502); (2) `.expect(200, { ok: true })` của supertest so **toàn bộ body**. Ngoài ra `/docs-json` do Swagger phục vụ bằng route Express, không qua interceptor, nên giữ dạng thô.
20. **Tham số mặc định nuốt `undefined`.** Test "thiếu `req.id`" gọi `run(…, undefined)` vào tham số có mặc định `'req-1'`, nên JS lấy luôn mặc định và test chỉ xanh nhờ may mắn, không kiểm tra gì. Đổi sang `{ requestId: null }`.
21. **`SKIP LOCKED` chứng minh được bằng `lock_timeout`, không cần đo thời gian.** Worker A giữ khoá 5 kênh cũ nhất; B gọi `purgeBatch({ limit: 5, lockTimeoutMs: 200 })`. Có `SKIP LOCKED` → B lấy ngay 5 kênh kế tiếp, hai lô không trùng nhau. Đột biến bỏ `SKIP LOCKED` → `pg:55P03` sau ~279 ms. `lock_timeout` vừa là thứ làm test xác định (không có nó, B đợi mãi, test treo thay vì đỏ), vừa là lưới an toàn ở production (job không bao giờ đứng đợi vô hạn).
22. **`SET LOCAL lock_timeout = $1` không chạy được với tham số bind.** Đã kiểm chứng trên Postgres thật: lỗi `42601 syntax error at or near "$1"`, vì `SET` không phải câu lệnh có tham số. Dùng `select set_config('lock_timeout', $1, true)` (`is_local = true`): bind được, chỉ có hiệu lực trong transaction, sau commit trở về `0`.
23. **Lưu trữ / xoá do OrgAdm làm cũng khoá bậc 1** (dòng tổ chức của người gọi, `FOR SHARE`), giống chuyển chủ kênh: quyền override dựa trên vai trò tổ chức, nên vai trò đó phải giữ nguyên tới lúc commit. Kênh đã xoá mềm vẫn còn dòng `channel_members` (kể cả chủ) tới khi bị dọn. Đây là điểm B7 phải lọc khi kiểm tra "còn làm chủ kênh nào".
24. **Race "gỡ X ‖ chuyển chủ kênh cho X" làm XÁC ĐỊNH cho cả hai thứ tự, thay vì chạy 10 vòng rồi hy vọng trúng.** Gỡ trước: T1 khoá dòng org của X → chuyển chủ (service thật) đợi → T1 xoá X → chuyển nhận 404 (`OK/NOT_FOUND/<chủ cũ>`). Chuyển trước: T1 làm đúng các bước khoá của chuyển chủ → `remove` (service thật) đợi → thấy X đã là chủ → 409 (`ORG_MEMBER_OWNS_CHANNELS/<X>`). Mỗi thứ tự một đột biến làm đỏ, và cả hai đều ra **kênh mất chủ**: chuyển không khoá dòng org của người nhận → `OK/OK/`; `remove` bỏ kiểm tra → `OK/`. Vòng lặp ngẫu nhiên chỉ trúng khoảng hở thời gian nếu may, còn ép thứ tự thì lần nào cũng trúng.
25. **Helper race phải chịu được code đột biến "không thèm đợi".** Code đúng thì T2 phải đợi khoá. Code đột biến có thể chạy thẳng tới commit, khiến `waitForLockWaiters` chờ đủ 5 s rồi báo lỗi timeout, tức test đỏ vì lý do sai. Đã thêm `stopWhen`: khi T2 xong thì thôi chờ, T1 làm tiếp, và assert thấy hậu quả thật (đột biến 1 đỏ sau 66 ms với `OK/OK/`).
26. **Truy vấn "đang làm chủ kênh nào" đặt trong repository thành viên ORG, đọc thẳng bảng kênh qua schema.** `ChannelsModule` đã import `OrganizationsModule`; inject ngược service kênh sẽ thành phụ thuộc vòng giữa module. Đọc ở tầng schema không tạo phụ thuộc module. **Thứ tự khoá có thêm bậc 0 `organizations`** cho xoá tổ chức: khoá dòng cha trước, rồi tới dòng thành viên của người gọi.
27. **Đối chiếu tài liệu bằng script, không bằng mắt (B8).** Script so route trong `openapi.json` với bảng 05-api: khớp hết, chỉ còn 5 route meetings / reports của M6 / M9. Script so `ErrorCode` với bảng 07: **thiếu 4 mã từ M1 / M3** (`AUTH_EMAIL_TAKEN`, `INVITE_NOT_FOUND`, `GONE`, `SERVICE_UNAVAILABLE`), lọt qua hai lần đóng mốc trước vì khi đó chỉ đọc lướt. Đã bổ sung.
28. **Chạy tay trên Docker Compose (B8):** `docker compose up --build -d --wait api worker` → `migrate` áp `0005_channels` rồi thoát 0, `api` healthy. Smoke test 20 bước gọi HTTP thật (mời → tạo kênh → thêm thành viên → tìm không dấu → chuyển chủ → rời org bị chặn kèm `details` → lưu trữ → sửa bị 409 → xoá kênh → rời org → xoá org → 404, cộng `x-request-id` client gửi được dùng lại ở `meta.requestId`): 20/20 đúng, log `api` / `worker` không có dòng `error`.
