# M2 — Tổ chức (lõi)

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-13, chọn ★ cho Q1–Q4)
- **Nhánh:** `m2-organizations`
- **Tài liệu thiết kế liên quan:** [01-overview D1](../design/01-overview.md), [03-database §2](../design/03-database.md), [04-authorization §1, §4](../design/04-authorization.md), [05-api Organizations](../design/05-api.md), [07-conventions §2, §4](../design/07-conventions.md)

## Mục tiêu

Cuối mốc, một user tạo được tổ chức và trở thành Owner. Owner quản lý thành viên: xem danh sách có phân trang cursor và tìm không dấu, đổi vai trò member ↔ admin, gỡ thành viên. Admin và Member bị chặn đúng ma trận quyền. `GET /v1/me` trả thêm danh sách org của tôi.

Đây là mốc dựng **khung phân quyền nhiều tầng** mà M3, M4 dùng lại:

- `OrgMemberGuard` tải membership theo `:orgId`;
- `@Require('org.…')` + `PermissionGuard` hỏi policy thuần;
- service kiểm tra lại theo đối tượng sau khi khoá dòng.

## Ngoài phạm vi

- **Thêm thành viên qua API** (link mời, duyệt yêu cầu), chuyển quyền sở hữu, rời org, audit log: để M3. Test của M2 thêm thành viên bằng cách chèn thẳng DB qua factory.
- Kênh và hệ quả của việc gỡ thành viên lên kênh (chuyển chủ kênh khi người bị gỡ là chủ kênh): để M4.
- Xoá org, nếu chọn ★ ở Q2.

## Quyết định cần duyệt

| #   | Câu hỏi                                                             | Đề xuất ★                                                                                                                                    | Phương án khác                                            |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Q1  | Org có `slug` (`/orgs/acme`) không?                                 | ★ **Chưa.** API dùng `:orgId` (uuid). Slug kéo theo sinh slug từ tên tiếng Việt, xử lý trùng, đổi tên → đổi slug, mà chưa có frontend cần nó | Có slug ngay, unique, sinh bằng `f_unaccent` + kebab-case |
| Q2  | Xoá org làm ở mốc nào?                                              | ★ **Hoãn tới M4**, khi đã có kênh/meeting và quyết định rõ xoá mềm ảnh hưởng gì                                                              | Làm ngay ở M2: xoá mềm `deleted_at`, chỉ Owner            |
| Q3  | Thành viên thường có thấy **email** của nhau trong danh sách không? | ★ **Có**, giống Slack/Google Workspace, vì cùng tổ chức                                                                                      | Chỉ Admin+ thấy email, Member chỉ thấy tên                |
| Q4  | Audit log cho đổi vai trò / gỡ thành viên                           | ★ **M3 thêm `AuditModule` rồi gắn ngược** vào các thao tác của M2. Giữ M2 tập trung vào phân quyền                                           | Kéo `AuditModule` vào M2                                  |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- `GET /v1/orgs` trả **mảng, không phân trang**, vì một người thuộc ít org.
- Tên org không cần unique toàn hệ thống.

## Thay đổi thiết kế

### Bảng (sửa `03-database.md` §2)

| Bảng                   | Cột                                                                       | Ràng buộc / index                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`        | id (uuidv7), name, created_by → users, created_at, updated_at, deleted_at | CHECK `char_length(name) between 1 and 100`. Bỏ `slug` (Q1). `require_join_approval` chuyển sang migration của M3, khi có tính năng dùng nó                                                                                                                                                                                       |
| `organization_members` | org_id, user_id, role, joined_at                                          | PK `(org_id, user_id)`<br>`organization_members_one_owner_uq`: `UNIQUE (org_id) WHERE role = 'owner'`<br>`organization_members_user_idx (user_id)`<br>`organization_members_org_joined_idx (org_id, joined_at, user_id)` cho phân trang<br>CHECK role ∈ owner/admin/member<br>FK tới organizations, users đều `ON DELETE CASCADE` |

### API (sửa `05-api.md`)

| Method | Path                                              | Ai gọi                       | Ghi chú                                                                                                   |
| ------ | ------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/orgs`                                        | User                         | 201. Người tạo thành Owner. Insert org + membership trong 1 transaction                                   |
| GET    | `/v1/orgs`                                        | User                         | Mảng org của tôi `{ id, name, role, joinedAt }`                                                           |
| GET    | `/v1/orgs/:orgId`                                 | Member+                      | `{ id, name, createdAt, myRole, memberCount }`                                                            |
| PATCH  | `/v1/orgs/:orgId`                                 | Admin+                       | Đổi tên                                                                                                   |
| GET    | `/v1/orgs/:orgId/members?q=&role=&cursor=&limit=` | Member+                      | `{ data: [{ userId, displayName, email, role, joinedAt }], nextCursor }`, sắp theo `(joined_at, user_id)` |
| PATCH  | `/v1/orgs/:orgId/members/:userId`                 | Owner                        | `{ role: 'admin' \| 'member' }`                                                                           |
| DELETE | `/v1/orgs/:orgId/members/:userId`                 | Owner; Admin (chỉ gỡ Member) | 204                                                                                                       |
| GET    | `/v1/me`                                          | User                         | Thêm `organizations: [{ id, name, role }]`                                                                |

### Quyền (sửa `04-authorization.md` §4)

Ba tầng, đúng như thiết kế:

1. **`OrgMemberGuard`** (gắn ở controller có `:orgId`):
   - `:orgId` không phải uuid → **404 ngay trong guard**. Guard chạy _trước_ pipe, nên `ParseUUIDPipe` chưa kịp chạy. Chuỗi rác đi xuống Postgres sẽ thành lỗi `22P02` → 500.
   - Không phải thành viên, hoặc org đã xoá → 404.
   - Hợp lệ thì gắn `req.orgMembership = { orgId, role }`.
2. **`@Require('org.member.remove')` + `PermissionGuard`:** tra `orgPolicy[permission](membership)`, trả **403** nếu sai.
   - Permission key có kiểu union, gõ sai thì lỗi lúc compile.
   - Guard dispatch theo tiền tố (`org.` → `orgPolicy`), để M4 thêm `channel.` mà không phải viết lại.
3. **Service (kiểm tra theo đối tượng, sau khi khoá dòng):**
   - `canChangeRole(actorRole, targetRole, newRole)` và `canRemoveMember(actorRole, targetRole, isSelf)` là hàm thuần trong `organization.policy.ts`.
   - Admin không gỡ được Admin/Owner. Không ai đổi vai trò hay gỡ được Owner (phải chuyển quyền sở hữu, M3). Owner không tự gỡ mình.

### Mã lỗi mới (sửa `07-conventions.md` §2)

| Mã                    | HTTP | Khi nào                                                                                                     |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`           | 404  | Org không tồn tại / không phải thành viên / `:orgId` sai định dạng; người bị tác động không phải thành viên |
| `FORBIDDEN`           | 403  | Vai trò không đủ cho hành động, hoặc cho đối tượng (Admin gỡ Admin)                                         |
| `ORG_OWNER_IMMUTABLE` | 409  | Đổi vai trò hoặc gỡ Owner. Gợi ý dùng chuyển quyền sở hữu (M3)                                              |

### Transaction / khoá

Đổi vai trò và gỡ thành viên dùng mẫu "đổi quyền" của skill `db-transactions`:

1. `BEGIN`.
2. `SELECT … FROM organization_members WHERE org_id = $1 AND user_id IN (actor, target) ORDER BY user_id FOR UPDATE`.
3. **Kiểm tra lại** vai trò của actor và target sau khi khoá (guard đọc lúc đầu có thể đã cũ).
4. `UPDATE` / `DELETE`, rồi `COMMIT`.

Ca race phải chặn được: Owner nâng B lên Admin **cùng lúc** Admin A gỡ B. Không khoá thì A đọc thấy B là Member, Owner nâng B, rồi A gỡ B → Admin gỡ được Admin, sai ma trận. Có khoá + kiểm tra lại thì hai thao tác **không thể cùng thành công**.

## Dependency mới

Không có.

## Các bước

Mỗi bước = 1 commit trên nhánh `m2-organizations`, chạy được và có test.

- [x] **B1 — Schema + migration** (skill `drizzle-schema`)
  - Việc: `schema/organizations.ts`, `pnpm db:generate --name=organizations`, đọc SQL.
  - Test (integration): 2 owner trong 1 org → 23505 `organization_members_one_owner_uq`; role lạ → 23514; xoá org → cascade membership; một user thuộc nhiều org.
- [x] **B2 — Policy thuần** (skill `authorization`)
  - Việc: `organization.policy.ts`: `OrgRole`, thứ hạng vai trò, `orgPolicy` (`org.read`, `org.update`, `org.member.list`, `org.member.role.change`, `org.member.remove`), `canChangeRole`, `canRemoveMember`.
  - Test (unit): `it.each` trên **toàn bộ** ma trận vai trò × hành động × vai trò đích.
- [x] **B3 — Repository + service: tạo org, org của tôi, chi tiết, đổi tên** (đã điều chỉnh: controller dời sang B4 cùng guard, để không commit nào có route `:orgId` chưa được bảo vệ)
  - Việc: `OrganizationsRepository`, `OrganizationsService` (tạo org + Owner trong 1 transaction), DTO, controller.
  - Test (integration): tạo org thì có đúng 1 membership owner.
- [x] **B4 — Controller + DTO + `OrgMemberGuard` + `@Require` + `PermissionGuard`** (route `/orgs` của B3 ra mắt cùng lúc với guard)
  - Việc: gắn guard vào các route `:orgId` của B3.
  - Test (e2e):
    - người ngoài `GET /orgs/:id` → 404;
    - `:orgId` = `abc` → 404 (không phải 500);
    - Member `PATCH` → 403, Admin `PATCH` → 200;
    - org của người khác không lộ trong `GET /orgs`.
- [ ] **B5 — Danh sách thành viên: cursor + tìm không dấu**
  - Việc: keyset pagination trên `(joined_at, user_id)` (timestamp lấy dạng text), lọc `role`, `q` tìm qua `users.search_text` (trigram). **Escape `%` `_` `\`** trong `q` trước khi đưa vào `LIKE`.
  - Test (e2e):
    - 25 thành viên, `limit=10` → 3 trang, không trùng, không sót;
    - `q=nguyen` khớp "Nguyễn";
    - `q=%` không khớp tất cả;
    - cursor hỏng → 400 `INVALID_CURSOR`.
- [ ] **B6 — Đổi vai trò** (skill `db-transactions`)
  - Việc: transaction + khoá 2 dòng theo `user_id` + kiểm tra lại.
  - Test (e2e, bảng):
    - Owner: member ↔ admin → 200;
    - Admin/Member đổi → 403;
    - đổi Owner → 409;
    - `role: 'owner'` → 400;
    - người ngoài org → 404.
- [ ] **B7 — Gỡ thành viên + test concurrency**
  - Test (e2e, bảng):
    - Owner gỡ Admin/Member → 204;
    - Admin gỡ Member → 204, Admin gỡ Admin → 403;
    - gỡ Owner → 409;
    - Member gỡ → 403;
    - người bị gỡ gọi lại org → 404.
  - **Test concurrency** (integration, 10 vòng): Owner nâng B **song song** với Admin A gỡ B → hai thao tác không bao giờ cùng thành công. **Bỏ `FOR UPDATE` thì test phải đỏ.**
- [ ] **B8 — `/me` có danh sách org + đóng mốc**
  - Việc:
    - `MeResponseDto.organizations`;
    - cập nhật `openapi.json`;
    - đối chiếu `03/04/05/07`;
    - ghi "Điều học được";
    - chạy tay trên Swagger.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và trên CI. Test concurrency đã chứng minh "bỏ lock là đỏ"
- [ ] Unit test phủ toàn bộ ma trận quyền cấp tổ chức của M2
- [ ] `openapi.json` có đủ route mới, mọi route `:orgId` khai báo 403/404
- [ ] `docs/design/` khớp với code

## Điều sẽ học

- Guard nhiều tầng: guard toàn cục → guard của controller (`OrgMemberGuard`) → `PermissionGuard`, và vì sao guard **không** thấy kết quả của pipe
- Policy là hàm thuần + `satisfies` để permission key có kiểu; tách kiểm tra "loại hành động" (guard) khỏi kiểm tra "đối tượng cụ thể" (service)
- 404 thay vì 403 để không lộ sự tồn tại của tài nguyên
- Keyset/cursor pagination thật trên dữ liệu thật, tie-breaker, timestamp micro giây
- Tìm không dấu với `pg_trgm` + `f_unaccent`, escape ký tự đặc biệt của `LIKE`
- Mẫu "đổi quyền": khoá nhiều dòng theo thứ tự, kiểm tra lại sau khi khoá, test concurrency giữa hai thao tác khác nhau

## Điều học được / bẫy gặp phải

1. **`@ts-expect-error` để test constraint ở tầng DB.** Drizzle gõ `role` thành union `'owner' | 'admin' | 'member'`, nên `'superadmin'` bị TypeScript chặn từ lúc compile. Muốn chứng minh CHECK ở DB vẫn chặn khi dữ liệu đi vào bằng đường khác (SQL thô, script), test phải cố tình vượt tầng kiểu. Nếu một ngày kiểu được nới lỏng, TS sẽ báo `Unused '@ts-expect-error'`, tức là test cũng tự "kêu".
2. **Index riêng cho `user_id` dù đã có PK `(org_id, user_id)`.** B-tree chỉ dùng được khi điều kiện chạm cột đầu tiên, nên "các org của tôi" (`WHERE user_id = ?`) không dùng được PK. `test/support/db-factories.ts` (`insertUser`, `insertOrg`, `addMember`) chèn thẳng DB vì M2 chưa có API thêm thành viên.
3. **Bớt tham số `isSelf` khỏi `canRemoveMember`.** Viết bảng test ra mới thấy quy tắc "Owner không tự gỡ mình" đã bị quy tắc "Owner bất biến" bao, còn "Admin tự gỡ mình" rơi vào "Admin chỉ gỡ Member". Ít tham số hơn thì ít tổ hợp phải test hơn. Viết **bảng test trước** giúp phát hiện quy tắc thừa.
4. **Test "bảng phủ đủ permission"** so `Object.keys(orgPolicy)` với cột đầu của bảng test. Thêm permission mới mà quên thêm dòng test thì test đỏ, nên ma trận và test không thể lệch nhau mà không ai biết.
5. **Đổi thứ tự bước để không commit nào lộ dữ liệu.** Plan ban đầu cho B3 làm controller, B4 mới gắn guard, tức commit B3 sẽ có `GET /orgs/:orgId` mà ai cũng đọc được. Nhánh có thể bị deploy hoặc cherry-pick ở bất kỳ commit nào, nên mỗi commit đều phải an toàn chứ không chỉ commit cuối. Cách đã chọn: B3 chỉ làm repository/service, B4 làm controller cùng guard.
6. **`@RequireOrgPermission` thay cho `@Require` + `PermissionGuard` chung (lệch plan, đã cập nhật `04-authorization.md` và skill `authorization`).**
   - Bản chung đặt ở `common/` phải import policy của từng module, tức `common` phụ thuộc ngược vào domain. Bản theo domain gộp `SetMetadata` + `UseGuards(OrgMemberGuard, OrgPermissionGuard)` + `ApiParam` + `ApiErrorResponses(401, 403, 404)` trong một decorator.
   - Nhờ gộp, không thể quên guard thành viên hay đặt sai thứ tự guard.
   - Guard dùng qua `@UseGuards` phải là provider trong module của controller. Module cũng export guard để M4 dùng lại.
7. **Đã kiểm chứng bẫy "guard chạy trước pipe".** Tạm bỏ kiểm tra uuid trong `OrgMemberGuard` thì `GET /v1/orgs/abc` và `GET /v1/orgs/1' or '1'='1` trả **500** (`22P02 invalid input syntax for type uuid`) thay vì 404. Không có SQL injection vì query được tham số hoá, nhưng thiếu kiểm tra thì vẫn lộ lỗi 500.
8. **Người ngoài `PATCH /orgs/:id` nhận 404, không phải 403.** Guard thành viên chạy trước guard quyền, nên người ngoài không bao giờ tới được bước "không đủ quyền". Bảng e2e có cả 4 dòng owner/admin/member/người ngoài → 200/200/403/404.
9. **Một test "xanh" của B3 chưa từng kiểm tra điều nó khẳng định.** Test "insert membership lỗi → org bị rollback" dùng `userId` không tồn tại. Nó pass, nhưng lỗi thật xảy ra ngay ở INSERT **đầu tiên** (`organizations_created_by_fk`), nên chưa có gì để rollback. Bị lộ khi sửa cảnh báo lint `require-to-throw-message`: buộc test chỉ rõ lỗi _nào_ thì lỗi thật hiện ra.
   - Sửa: dùng user có thật, rồi `vi.spyOn(repo, 'insertMember').mockRejectedValueOnce(...)` để chỉ bước thứ hai hỏng.
   - Kiểm chứng ngược: cho INSERT org chạy ngoài transaction thì test mới **đỏ** (sót 1 org).
   - Bài học: `toThrow()` không kèm điều kiện là assertion yếu. Mỗi test về transaction/khoá phải được "đột biến" (bỏ khoá / bỏ transaction) ít nhất một lần để chắc nó đỏ được.
