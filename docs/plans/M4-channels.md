# M4 — Kênh

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-14: ★ cho Q1, Q2, Q4; **Q3 đổi theo người dùng**: phải chuyển chủ kênh trước, giống Owner tổ chức)
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
| Q4  | Danh sách kênh sắp xếp thế nào?                   | ★ **Theo tên A→Z**: keyset trên `(lower(name), id)`, dùng lại unique index `(org_id, lower(name)) WHERE deleted_at IS NULL`. Học thêm cursor trên **biểu thức**                                                                                                                                         | Mới nhất trước theo `created_at`                                   |

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
- [ ] **B3 — Guard + tạo / liệt kê / xem / sửa kênh**
  - Việc: `ChannelAccessGuard`, `@RequireChannelPermission`, CRUD có audit, danh sách theo tên (keyset trên biểu thức, Q4).
  - Test (e2e):
    - kênh riêng tư → người ngoài 404, OrgAdm thấy metadata;
    - danh sách lọc đúng theo quyền thấy;
    - tên trùng → 409;
    - phân trang theo tên không trùng/sót.
- [ ] **B4 — Thành viên kênh**
  - Việc: liệt kê (cursor + tìm không dấu), thêm, đổi vai trò, gỡ. Mọi thao tác khoá **dòng kênh trước** (mutex) rồi mới khoá dòng thành viên.
  - Test (e2e): bảng phân quyền đầy đủ; Khách xem danh sách → 403.
  - **Race:** lưu trữ kênh ‖ thêm thành viên → không bao giờ "thêm thành công vào kênh đã lưu trữ". Đột biến bỏ kiểm tra lại sau khoá → đỏ.
- [ ] **B5 — Join / leave + chuyển chủ kênh**
  - Việc: theo `06-flows.md` §3, áp **thứ tự khoá chung**.
  - Test (e2e): CO rời → 409; chuyển cho Khách → 409; OrgAdm chuyển hộ được.
  - **Race:** OrgAdm chuyển chủ kênh ‖ Owner gỡ chính OrgAdm đó khỏi org → không deadlock. **Đột biến đảo thứ tự khoá → `40P01`.**
- [ ] **B6 — Lưu trữ / bỏ lưu trữ / xoá mềm + logic dọn dẹp**
  - Việc: lưu trữ chặn ghi (409); xoá mềm thì 404 với mọi người, tên dùng lại được; `purgeBatch` dùng `FOR UPDATE SKIP LOCKED`.
  - **Test xác định (không phụ thuộc thời gian):** transaction A giữ khoá 5 kênh, transaction B (đặt `lock_timeout`) phải lấy ngay 5 kênh **khác**. Đột biến bỏ `SKIP LOCKED` → B lỗi `55P03` (hết thời gian chờ khoá).
- [ ] **B7 — Chặn rời / gỡ khỏi tổ chức khi còn làm chủ kênh + xoá tổ chức**
  - Việc:
    - `remove` / `leave` của tổ chức kiểm tra người đó còn làm chủ kênh nào (chưa xoá) → 409 `ORG_MEMBER_OWNS_CHANNELS` kèm danh sách kênh (Q3);
    - `DELETE /v1/orgs/:orgId` (Q2).
  - **Race phải chặn:** Admin gỡ X ‖ chủ kênh chuyển kênh cho X. Không phối hợp khoá thì: gỡ kiểm tra "X không làm chủ kênh nào" → chuyển kênh commit → gỡ xoá membership của X → cascade xoá dòng chủ kênh → **kênh mất chủ**.
    - Cách chặn bằng thứ tự khoá chung: chuyển chủ kênh khoá `FOR SHARE` dòng thành viên tổ chức của **người nhận** (bậc 1) trước khi khoá kênh; gỡ khoá `FOR UPDATE` cùng dòng đó. Kết quả là hai thao tác chạy tuần tự.
    - Ai trước cũng ra kết cục hợp lệ: chuyển trước → gỡ thấy X làm chủ → 409; gỡ trước → chuyển thấy X không còn trong org → 404.
  - Test (integration, 10 vòng): race trên → không bao giờ có kênh mất chủ. **Đột biến** bỏ khoá dòng thành viên tổ chức của người nhận → kênh mất chủ (đỏ).
  - Test (e2e): chủ kênh rời org → 409 kèm tên kênh; chuyển chủ kênh xong thì rời được; Owner org xoá org → mọi route bên trong 404.
- [ ] **B8 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu, chạy tay trên Docker Compose, ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI; các race test + test `SKIP LOCKED` đều đã được đột biến
- [ ] Ma trận quyền kênh (§2) pass toàn bộ ở unit và e2e dạng bảng
- [ ] Không còn đường nào để kênh mất chủ (gỡ / rời / chuyển), kể cả khi các thao tác chạy song song
- [ ] `docs/design/` khớp với code, có **thứ tự khoá chung** trong §7

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
