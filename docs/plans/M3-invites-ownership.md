# M3 — Mời, duyệt, chuyển quyền sở hữu, rời tổ chức, audit log

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-13, chọn ★ cho Q1–Q5)
- **Nhánh:** `m3-invites-ownership`
- **Tài liệu thiết kế liên quan:** [01-overview D7](../design/01-overview.md), [03-database §2, §6](../design/03-database.md), [04-authorization §1](../design/04-authorization.md), [05-api Organizations](../design/05-api.md), [06-flows](../design/06-flows.md)

## Mục tiêu

Cuối mốc, tổ chức có đường vào và đường ra hoàn chỉnh:

- **Mời:** Owner/Admin tạo link mời có hạn dùng và giới hạn số lượt. Người nhận mở link, xem trước tên tổ chức, rồi chấp nhận.
- **Duyệt:** nếu tổ chức bật `require_join_approval`, việc chấp nhận link chỉ tạo **yêu cầu tham gia**, và Owner/Admin duyệt hoặc từ chối.
- **Chuyển quyền sở hữu:** Owner chuyển cho một thành viên khác; Owner cũ thành Admin.
- **Rời tổ chức:** Admin/Member tự rời. Owner phải chuyển quyền sở hữu trước.
- **Audit log:** mọi thao tác quản trị, kể cả các thao tác của M2 (tạo org, đổi tên, đổi vai trò, gỡ thành viên), ghi vào audit log **trong cùng transaction**. Owner/Admin xem được.

Mốc này có **ba kiểu xử lý đồng thời khác nhau**, mỗi kiểu một test race:

| Chỗ           | Kỹ thuật                                                        | Race cần chặn                                                                 |
| ------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Dùng link mời | Một `UPDATE … WHERE use_count < max_uses RETURNING`, không khoá | 30 người bấm link 10 lượt → đúng 10 người vào                                 |
| Duyệt yêu cầu | `SELECT … FOR UPDATE` dòng yêu cầu                              | 2 Admin cùng bấm duyệt → đúng 1 lần duyệt                                     |
| Chuyển sở hữu | Khoá 2 dòng thành viên theo thứ tự, **hạ trước nâng sau**       | Owner chuyển cho B và C cùng lúc → đúng 1 Owner, request kia nhận 403 rõ ràng |

## Ngoài phạm vi

- Gửi email mời (dự án chưa có email, xem `01-overview` §3). Người tạo link tự gửi link.
- Người dùng tự huỷ yêu cầu tham gia đang chờ.
- Xoá tổ chức (đã hoãn tới M4 ở M2 Q2).
- Kênh. Khi gỡ hoặc rời mà người đó là chủ kênh thì M4 xử lý.

## Quyết định cần duyệt

| #   | Câu hỏi                                                               | Đề xuất ★                                                                                                                                                                                                              | Phương án khác                                                                                              |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Q1  | Token của link mời xem lại được không?                                | ★ **Chỉ hiện MỘT lần lúc tạo** (giống token GitHub). DB chỉ lưu SHA-256, cách làm giống refresh token ở M1. Mất link thì tạo link mới                                                                                  | Lưu token mã hoá để xem lại: phải quản lý khoá mã hoá, và lộ DB là lộ mọi link                              |
| Q2  | Khi tổ chức cần duyệt, **lượt dùng** của link bị trừ lúc nào?         | ★ **Lúc chấp nhận link** (tạo yêu cầu chờ duyệt). Nhờ vậy link 10 lượt không bị spam ra 1000 yêu cầu chờ                                                                                                               | Lúc được duyệt: phức tạp hơn, và lượt dùng không còn chặn được spam                                         |
| Q3  | Audit log lấy `actor`, `requestId`, `ip` từ đâu?                      | ★ **Truyền tường minh** một `AuditContext` từ controller xuống service (decorator `@AuditCtx()`). Dễ đọc, dễ test, không có "ma thuật"                                                                                 | `AsyncLocalStorage` (vd `nestjs-cls`): đỡ phải truyền tham số, nhưng thêm dependency và luồng dữ liệu bị ẩn |
| Q4  | Bảo đảm audit log "chỉ ghi thêm" bằng gì?                             | ★ **Trigger trong DB** chặn `UPDATE`/`DELETE` trên `audit_logs`. `REVOKE` không có tác dụng ở đây, vì user ứng dụng là chủ của bảng. Audit log **không có FK** tới user/org, để còn tồn tại khi các bản ghi kia bị xoá | Chỉ là quy ước trong code                                                                                   |
| Q5  | Xem trước link mời (`GET /v1/invites/:token`) có cần đăng nhập không? | ★ **Không** (`@Public`). Người nhận chưa có tài khoản cũng biết được mình được mời vào đâu. Link chính là bí mật, ai có link mới xem được tên tổ chức                                                                  | Bắt đăng nhập trước, như thiết kế cũ                                                                        |

## Thay đổi thiết kế

### Bảng (sửa `03-database.md` §2, §6)

| Bảng                         | Cột chính                                                                                                                  | Ràng buộc / index                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`              | thêm `require_join_approval boolean NOT NULL DEFAULT false`                                                                |                                                                                                                                                                                                                         |
| `organization_invites`       | id, org_id, token_hash (bytea 32), role, created_by, expires_at, max_uses NULL, use_count, revoked_at, created_at          | `UNIQUE (token_hash)`<br>CHECK role ∈ admin/member<br>CHECK `max_uses IS NULL OR max_uses > 0`<br>CHECK `use_count BETWEEN 0 AND COALESCE(max_uses, use_count)`<br>index `(org_id, created_at DESC, id DESC)`           |
| `organization_join_requests` | id, org_id, user_id, invite_id NULL, role, status, decided_by NULL, decided_at NULL, created_at                            | `UNIQUE (org_id, user_id) WHERE status = 'pending'`<br>CHECK status ∈ pending/approved/rejected<br>CHECK nhất quán: `(status = 'pending') = (decided_at IS NULL)`<br>index `(org_id, status, created_at DESC, id DESC)` |
| `audit_logs`                 | id bigint identity, org_id, actor_id NULL, action, target_type, target_id, metadata jsonb, request_id, ip inet, created_at | **Không FK** (Q4)<br>index `(org_id, created_at DESC, id DESC)`<br>trigger `audit_logs_append_only` chặn UPDATE/DELETE                                                                                                  |

### API (sửa `05-api.md`)

| Method | Path                                                  | Ai gọi                                        | Ghi chú                                                                                                      |
| ------ | ----------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| PATCH  | `/v1/orgs/:orgId`                                     | Admin+                                        | Thêm field `requireJoinApproval`                                                                             |
| POST   | `/v1/orgs/:orgId/invites`                             | Admin+ (link role `admin` chỉ Owner)          | `{ role?, expiresInHours? (1–720, mặc định 168), maxUses? (1–1000) }` → 201, **có `token` một lần duy nhất** |
| GET    | `/v1/orgs/:orgId/invites?cursor=`                     | Admin+                                        | Không bao giờ trả token. Phân trang **giảm dần** theo thời điểm tạo                                          |
| DELETE | `/v1/orgs/:orgId/invites/:inviteId`                   | Admin+                                        | Thu hồi → 204                                                                                                |
| GET    | `/v1/invites/:token`                                  | **Public** (Q5)                               | `{ orgName, role, expiresAt, requiresApproval }`. Không có → 404. Hết hạn / hết lượt → **410**               |
| POST   | `/v1/invites/:token/accept`                           | User                                          | `{ status: 'joined', orgId }` hoặc `{ status: 'pending', requestId }`. Đã là thành viên → 409                |
| GET    | `/v1/orgs/:orgId/join-requests?status=&cursor=`       | Admin+                                        | Mặc định `status=pending`                                                                                    |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/approve`    | Admin+ (yêu cầu role `admin` chỉ Owner duyệt) |                                                                                                              |
| POST   | `/v1/orgs/:orgId/join-requests/:requestId/reject`     | Admin+                                        |                                                                                                              |
| POST   | `/v1/orgs/:orgId/ownership-transfer`                  | Owner                                         | `{ newOwnerId }`. Owner cũ thành Admin                                                                       |
| POST   | `/v1/orgs/:orgId/leave`                               | Admin, Member                                 | Owner → 409 `ORG_OWNER_MUST_TRANSFER`                                                                        |
| GET    | `/v1/orgs/:orgId/audit-logs?action=&actorId=&cursor=` | Admin+                                        | Mới nhất trước                                                                                               |

### Quyền (bổ sung `organization.policy.ts` và `04-authorization.md` §1)

- **Permission mới:**
  - `org.invite.manage`, `org.join_request.manage`, `org.audit.read`: Admin+
  - `org.ownership.transfer`: Owner
  - `org.leave`: mọi thành viên; service chặn Owner bằng 409
- **Hàm theo đối tượng mới `canGrantRole(actor, role)`:** dùng cho cả tạo link mời lẫn duyệt yêu cầu.
  - Owner cấp được admin và member.
  - Admin chỉ cấp được member.
  - Tức "không ai cấp được vai trò ngang hoặc cao hơn mình", trừ Owner.

### Mã lỗi mới

| Mã                                               | HTTP                                                     |
| ------------------------------------------------ | -------------------------------------------------------- |
| `INVITE_NOT_FOUND`                               | 404, kể cả link đã thu hồi                               |
| `INVITE_EXPIRED`, `INVITE_EXHAUSTED`             | **410 Gone**: link từng hợp lệ nhưng không còn dùng được |
| `ORG_ALREADY_MEMBER`, `ORG_JOIN_REQUEST_PENDING` | 409                                                      |
| `JOIN_REQUEST_NOT_PENDING`                       | 409: đã duyệt/từ chối rồi                                |
| `ORG_OWNER_MUST_TRANSFER`                        | 409: Owner rời tổ chức                                   |
| `ORG_TRANSFER_INVALID_TARGET`                    | 409: chuyển cho chính mình                               |

## Dependency mới

Không có.

## Các bước

Mỗi bước = 1 commit, chạy được và có test. Mỗi chỗ có khoá hoặc UPDATE có điều kiện đều có test race, và được **đột biến** để chắc test đỏ được (bài học M2 #9).

- [x] **B1 — Schema + migration** (skill `drizzle-schema`)
  - Việc: 3 bảng mới, cột `require_join_approval`, migration viết tay cho trigger chỉ-ghi-thêm.
  - Test (integration):
    - CHECK của `use_count` / `max_uses`;
    - 2 yêu cầu `pending` cùng user + org → 23505;
    - `UPDATE`/`DELETE` audit log → lỗi do trigger.
- [x] **B2 — `AuditModule` + gắn ngược vào M2** (skill `db-transactions`)
  - Việc:
    - `AuditService.record(tx, entry)`, `@AuditCtx()` (Q3);
    - tạo org / đổi tên / đổi vai trò / gỡ thành viên ghi audit trong cùng transaction (đổi tên chuyển vào transaction).
  - Test (integration): có dòng audit đúng `{ before, after }`; thao tác lỗi thì **không** có audit (đột biến: ghi audit ngoài transaction → đỏ).
- [x] **B3 — Policy bổ sung**
  - Việc: 5 permission mới + `canGrantRole`.
  - Test (unit): bảng ma trận đầy đủ, test "bảng phủ đủ permission" tự đỏ nếu thiếu dòng.
- [x] **B4 — Quản lý link mời**
  - Việc: tạo (token hiện một lần), liệt kê (cursor **giảm dần**: so sánh tuple dùng `<`), thu hồi.
  - Test (e2e):
    - Admin tạo link role `admin` → 403;
    - danh sách không chứa token;
    - phân trang giảm dần không trùng/sót;
    - Member → 403.
- [ ] **B5 — Xem trước + chấp nhận link** (UPDATE nguyên tử)
  - Việc: preview public, accept → vào thẳng hoặc tạo yêu cầu chờ duyệt (Q2), lượt dùng bị trừ trong cùng transaction với việc thêm thành viên.
  - Test (e2e): hết hạn/hết lượt → 410, thu hồi → 404, đã là thành viên → 409 và **không** bị trừ lượt.
  - **Race (integration):** 30 người chấp nhận link `maxUses = 10` song song → đúng 10 thành viên mới, `use_count = 10`. Đột biến "đọc rồi kiểm tra rồi ghi" → hơn 10 người vào.
- [ ] **B6 — Yêu cầu tham gia + bật/tắt duyệt**
  - Việc: `PATCH /orgs/:orgId` có `requireJoinApproval`; liệt kê, duyệt, từ chối (`FOR UPDATE`).
  - Test (e2e): Admin duyệt yêu cầu role `admin` → 403; duyệt lần hai → 409.
  - **Race:** 2 Admin duyệt cùng lúc → đúng 1 thành công. Bỏ khoá → đỏ.
- [ ] **B7 — Chuyển quyền sở hữu + rời tổ chức**
  - Việc: khoá (owner, người nhận) theo `user_id`, kiểm tra lại, **hạ trước nâng sau**.
  - Test (e2e): Owner cũ thành Admin và mất quyền Owner ngay; người nhận không phải thành viên → 404; chuyển cho chính mình → 409; Owner rời → 409; Admin rời → 204 và mất quyền.
  - **Đột biến 1:** nâng trước hạ sau → 23505. Chứng minh partial unique index không deferrable.
  - **Race:** Owner chuyển cho B ‖ cho C → đúng 1 Owner, request kia **403** (không còn là Owner). Bỏ khoá thì vẫn chỉ 1 Owner nhờ unique index, nhưng request kia nhận **409 CONFLICT** chung chung thay cho 403. Constraint là lưới an toàn cuối, còn khoá cho ra **ngữ nghĩa lỗi đúng**.
- [ ] **B8 — API xem audit log + đóng mốc**
  - Việc: `GET /orgs/:orgId/audit-logs` (cursor giảm dần, lọc theo `action`/`actorId`); cập nhật `openapi.json`, đối chiếu tài liệu, chạy tay trên Docker Compose.
  - Test (e2e): Member → 403; lọc đúng; thứ tự mới nhất trước.

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI; 3 race test (B5, B6, B7) đều đã được đột biến để chứng minh đỏ được
- [ ] Mọi thao tác quản trị của M2 + M3 đều có audit log trong cùng transaction
- [ ] `openapi.json` có đủ route mới, có response 410 cho link hết hạn
- [ ] `docs/design/` khớp với code

## Điều sẽ học

- UPDATE có điều kiện + `RETURNING` làm "khoá ngầm": khi nào đủ, khi nào phải `SELECT … FOR UPDATE`
- Thứ tự ghi khi có partial unique index (không deferrable), và vai trò của constraint làm lưới an toàn cuối so với khoá để có ngữ nghĩa lỗi đúng
- Audit log trong cùng transaction, chỉ-ghi-thêm bằng trigger, vì sao audit log không nên có FK
- Token chỉ hiện một lần, lưu hash
- Phân trang cursor **giảm dần** (so sánh tuple với `<`, index `DESC`)
- Mã 410 Gone vs 404, 409 vs 403: chọn mã lỗi theo ngữ nghĩa

## Điều học được / bẫy gặp phải

1. **Index `DESC` phải khớp thứ tự NULL của `ORDER BY`.** `.desc()` của Drizzle sinh index `DESC NULLS LAST`, nhưng `ORDER BY x DESC` của Postgres mặc định là `NULLS FIRST`. Lệch nhau thì planner đọc index xong vẫn phải **thêm bước Sort**, kể cả khi cột là NOT NULL. Sửa: `.desc().nullsFirst()`. Đã chứng minh bằng `EXPLAIN` trong integration test, và đột biến (đổi index về `NULLS LAST`) làm cả hai test đổi chiều.
2. **Test `EXPLAIN` phải chốt điều kiện planner.** Lần đầu ca "khớp index" vẫn ra `Sort`, vì bảng trong test chưa có thống kê nên planner chọn **bitmap scan**, mà bitmap scan không giữ thứ tự. Cách làm: `ANALYZE` trước, rồi `SET LOCAL enable_seqscan = off` + `enable_bitmapscan = off` trong một transaction riêng. Không nên tin plan của một bảng chưa `ANALYZE`.
3. **`REVOKE` không bảo vệ được bảng khỏi chính chủ của nó.** User ứng dụng là chủ bảng `audit_logs`, nên "chỉ ghi thêm" được ép bằng trigger: `BEFORE UPDATE OR DELETE FOR EACH ROW` cộng thêm `BEFORE TRUNCATE FOR EACH STATEMENT`, vì TRUNCATE không kích hoạt trigger cấp dòng. Lỗi mang SQLSTATE `23001` (`restrict_violation`).
4. **Audit log không có FK.** FK `ON DELETE SET NULL` sẽ phải UPDATE dòng log, đúng điều trigger cấm. Log cũng phải sống lâu hơn bản ghi mà nó mô tả.
5. **Dùng `this.db` bên trong transaction có khoá dòng thì request treo vô hạn, Postgres không báo deadlock.** Đột biến "xoá thành viên ngoài transaction" không cho ra kết quả "thành viên bị xoá" như dự đoán, mà **treo 30s tới timeout**:
   - transaction đã `FOR UPDATE` dòng đó trên connection A;
   - lệnh `DELETE` qua `this.db` lấy connection B của pool và chờ khoá của A;
   - A lại đang chờ B xong.
     Postgres chỉ thấy A "idle in transaction", không phải hai transaction khoá chéo nhau, nên không có `40P01`. Bài học kép:
   - trong transaction **mọi** câu lệnh phải đi qua `tx` (AuditService cố ý không có default `this.db`);
   - production nên đặt `lock_timeout` / `idle_in_transaction_session_timeout` để lỗi thay vì treo (ghi vào M11 hardening).
6. **Không ghi audit cho thao tác không đổi gì** (đổi vai trò member → member, sửa org với tên y nguyên). Log chỉ chứa field thực sự đổi (`{ before, after }`), để audit đọc được chứ không thành nhiễu.
7. **Quy trình: nối bước commit bằng `;` sau `format:check` là sai.** Commit B1 lọt một file chưa format vì `;` không dừng khi lệnh trước lỗi. Đã sửa bằng `--amend` (commit chưa push). Bước commit chỉ được chạy khi kiểm tra trước đó qua.
8. **`FOR SHARE` cho "vai trò của tôi phải giữ nguyên trong lúc tôi làm".** Tạo link mời là cấp quyền, nên vai trò người tạo được khoá `FOR SHARE` rồi kiểm tra lại bằng `canGrantRole`. Nhiều request đọc cùng lúc vẫn được, nhưng lệnh đổi vai trò (`FOR UPDATE`) phải đợi. Không cần khoá độc quyền như ở đổi vai trò.
9. **Cursor giảm dần: so sánh tuple dùng `<`.** Đột biến copy nhầm `>` từ bản ASC thì chỉ thu được 9/12 link: trang 2 lặp lại các link mới hơn rồi dừng. Index `(org_id, created_at DESC, id DESC)` + `ORDER BY … DESC` khớp thứ tự NULL (bài học 1).
10. **Lint bắt được một bug thật: module chỉ được `import` mà không có trong mảng `imports` của `@Module`.** Đoạn sửa `app.module.ts` bằng script không khớp vì Prettier đã gộp mảng lên một dòng, nên `InvitesModule` chỉ có dòng `import` ở đầu file. oxlint báo `no-unused-vars`. Nếu bỏ qua cảnh báo thì mọi route `/invites` trả 404. **Cảnh báo lint không phải chuyện thẩm mỹ.**
11. **Token và hash của token đều không vào audit log.** Audit log được nhiều người đọc hơn bảng `organization_invites`. Test e2e kiểm tra chuỗi token không xuất hiện trong dòng audit.
12. Helper `common/crypto/opaque-token.ts` (`generateOpaqueToken`, `hashOpaqueToken`) dùng chung cho refresh token (M1) và link mời. `TokenService` chuyển sang dùng nó mà không đổi hành vi (15 test auth vẫn xanh).
