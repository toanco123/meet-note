# M1 — Auth

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-13, chọn ★ cho Q1–Q4)
- **Nhánh:** `m1-auth`
- **Tài liệu thiết kế liên quan:** [01-overview D1, D7](../design/01-overview.md), [03-database §1](../design/03-database.md), [04-authorization §4](../design/04-authorization.md), [05-api Auth](../design/05-api.md), [07-conventions §2, §6](../design/07-conventions.md)

## Mục tiêu

Cuối mốc, trên Swagger UI làm được trọn luồng: **đăng ký → đăng nhập → bấm Authorize → gọi `/v1/me` → refresh → logout**. Mọi route mặc định yêu cầu đăng nhập (guard toàn cục), trừ những route đánh dấu `@Public()`. Refresh token xoay vòng mỗi lần dùng. Token cũ bị dùng lại thì cả phiên bị thu hồi. Có test concurrency đầu tiên của dự án.

## Ngoài phạm vi

- Xác thực email, quên mật khẩu, đổi mật khẩu, OAuth/SSO, 2FA (xem `01-overview` §3)
- Rate limit / khoá tài khoản khi đăng nhập sai nhiều lần (M11)
- Refresh token trong httpOnly cookie (đã chọn trả trong body, D7)
- Danh sách org trong `GET /v1/me`: thêm ở M2, khi có bảng tổ chức
- Phân quyền theo vai trò (M2+). M1 chỉ trả lời câu hỏi "đã đăng nhập chưa"

## Quyết định cần duyệt

| #   | Câu hỏi                                                       | Đề xuất ★                                                                                                                                                                                                                                          | Phương án khác                                                                                      |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Q1  | Guard có kiểm tra phiên còn hiệu lực ở **mỗi request** không? | ★ Có. Verify chữ ký JWT, rồi tra `sessions` theo PK (`revoked_at IS NULL`). Logout / thu hồi thiết bị có hiệu lực **ngay**, đúng tinh thần D1 "đổi quyền có hiệu lực ngay". Chi phí: 1 query theo khoá chính, ~0.1 ms                              | Chỉ verify chữ ký (stateless). Nhanh hơn, nhưng access token còn sống tối đa 15 phút sau khi logout |
| Q2  | Hai tab cùng refresh một lúc thì sao?                         | ★ **Grace window 10 giây.** Token vừa bị xoay mà được dùng lại trong 10 giây thì trả 401 `AUTH_REFRESH_TOKEN_ROTATED` và **không** thu hồi phiên. Client dùng token mới mà tab kia đã nhận. Quá 10 giây mới coi là bị đánh cắp và thu hồi cả phiên | Không có grace: an toàn tuyệt đối hơn, nhưng người dùng mở nhiều tab sẽ bị logout ngẫu nhiên        |
| Q3  | Dùng Passport (`@nestjs/passport`)?                           | ★ **Không.** Tự viết `JwtAuthGuard` với `JwtService.verifyAsync`, để thấy rõ guard hoạt động ra sao. Ít dependency hơn                                                                                                                             | Passport: quen thuộc trong tài liệu Nest, nhưng che bớt cơ chế                                      |
| Q4  | Thuật toán ký JWT                                             | ★ **HS256** + `JWT_ACCESS_SECRET` (≥ 32 ký tự). Chỉ api ký và verify                                                                                                                                                                               | EdDSA/RS256 với cặp khoá: cần khi bên thứ ba phải verify token. Chưa cần                            |

## Thay đổi thiết kế

### Bảng: tách "phiên" khỏi "refresh token" (sửa `03-database.md` §1)

Thiết kế cũ gộp phiên và token vào một bảng `sessions` kèm `family_id`. Mỗi lần refresh tạo dòng mới nên `sid` trong JWT đổi liên tục. Hệ quả: guard khó kiểm tra "phiên còn sống", và `/me/sessions` khó liệt kê thiết bị. Thiết kế mới:

| Bảng             | Cột chính                                                                                                                                                                               | Ghi chú                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `users`          | như cũ                                                                                                                                                                                  | `UNIQUE (lower(email))` tên `users_email_lower_uq`, `search_text` generated + GIN trigram |
| `sessions`       | id (= `sid` trong JWT, **không đổi** suốt phiên), user_id, user_agent, ip, created_at, last_used_at, revoked_at, revoked_reason (`logout\|logout_all\|revoked_by_user\|reuse_detected`) | Một dòng = một lần đăng nhập trên một thiết bị                                            |
| `refresh_tokens` | id, session_id FK CASCADE, token_hash bytea UNIQUE, expires_at, created_at, rotated_at NULL, replaced_by_id NULL                                                                        | Mỗi lần refresh tạo một dòng mới, dòng cũ được set `rotated_at`                           |

Refresh (trong 1 transaction):

1. `SELECT … FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, rồi `SELECT … FROM sessions WHERE id = … FOR UPDATE`.
2. Không tìm thấy, hết hạn, hoặc phiên đã thu hồi → 401 `AUTH_REFRESH_TOKEN_INVALID`.
3. `rotated_at` đã có:
   - trong grace window → 401 `AUTH_REFRESH_TOKEN_ROTATED`;
   - quá grace → **thu hồi phiên** (`reuse_detected`), 401 `AUTH_REFRESH_TOKEN_REUSED`.
4. Hợp lệ: insert token mới, set `rotated_at` + `replaced_by_id` cho token cũ, cập nhật `sessions.last_used_at`.

Refresh token: 32 byte ngẫu nhiên (`crypto.randomBytes`), mã hoá base64url. DB lưu **SHA-256**, không dùng argon2: token có entropy cao nên không cần hash chậm, và cần tra cứu nhanh theo unique index.

### API (sửa `05-api.md`)

| Method | Path                         | Ai gọi | Response                                                                                         |
| ------ | ---------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| POST   | `/v1/auth/register`          | Public | 201 `AuthTokensResponseDto`                                                                      |
| POST   | `/v1/auth/login`             | Public | 200 `AuthTokensResponseDto`                                                                      |
| POST   | `/v1/auth/refresh`           | Public | 200 `AuthTokensResponseDto`                                                                      |
| POST   | `/v1/auth/logout`            | User   | 204                                                                                              |
| POST   | `/v1/auth/logout-all`        | User   | 204                                                                                              |
| GET    | `/v1/me`                     | User   | `MeResponseDto` (M2 thêm `organizations`)                                                        |
| PATCH  | `/v1/me`                     | User   | `MeResponseDto`                                                                                  |
| GET    | `/v1/me/sessions`            | User   | `SessionResponseDto[]` (có `current: true` cho phiên đang dùng). Ít phần tử nên không phân trang |
| DELETE | `/v1/me/sessions/:sessionId` | User   | 204. Phiên của người khác → 404                                                                  |

`AuthTokensResponseDto = { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, tokenType: 'Bearer' }`

### Mã lỗi mới (sửa `07-conventions.md` §2)

| Mã                                                                 | HTTP | Khi nào                                                             |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------------- |
| `AUTH_EMAIL_TAKEN`                                                 | 409  | Đăng ký email đã tồn tại (map từ constraint `users_email_lower_uq`) |
| `AUTH_INVALID_CREDENTIALS`                                         | 401  | Sai email **hoặc** mật khẩu. Không phân biệt, để tránh dò email     |
| `AUTH_TOKEN_MISSING` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401  | Access token thiếu / sai chữ ký hoặc định dạng / hết hạn            |
| `AUTH_SESSION_REVOKED`                                             | 401  | Access token hợp lệ nhưng phiên đã bị thu hồi (Q1)                  |
| `AUTH_REFRESH_TOKEN_INVALID` / `_ROTATED` / `_REUSED`              | 401  | Xem luồng refresh ở trên                                            |

### Biến môi trường (sửa `07-conventions.md` §6)

| Biến                          | Mặc định     | Ghi chú                                                       |
| ----------------------------- | ------------ | ------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`           | – (bắt buộc) | ≥ 32 ký tự. `.env.example` ghi rõ chỉ dùng cho dev            |
| `JWT_ACCESS_TTL_SECONDS`      | `900`        |                                                               |
| `REFRESH_TOKEN_TTL_DAYS`      | `30`         | Trượt: mỗi lần refresh, token mới có hạn 30 ngày kể từ lúc đó |
| `REFRESH_REUSE_GRACE_SECONDS` | `10`         | Q2                                                            |

### Dependency mới (theo skill `add-dependency`, đã tra 2026-10-13)

| Package       | Phiên bản | Ghi chú                                                                                                                      |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `argon2`      | 0.45.1    | Native addon (`node-gyp-build`). Cần `pnpm approve-builds argon2`. Phải kiểm tra prebuild cho alpine (musl) khi build Docker |
| `@nestjs/jwt` | 12.0.3    | peer `@nestjs/common ^12` OK. Kéo theo `jsonwebtoken` 9.0.3                                                                  |

## Các bước

Mỗi bước = 1 commit trên nhánh `m1-auth`, chạy được và có test.

- [x] **B1 — Dependency + config**
  - Việc:
    - cài `argon2`, `@nestjs/jwt` và duyệt build cho argon2;
    - thêm 4 biến env vào `EnvironmentVariables`;
    - cập nhật `.env.example`, `compose.yaml`, `test/support/setup-e2e.ts`;
    - cập nhật `src/scripts/export-openapi.ts` (cần secret giả, vì ConfigModule validate lúc import).
  - Test:
    - unit `validateEnv`: secret < 32 ký tự → lỗi, mặc định đúng;
    - CI build Docker xác nhận argon2 chạy trên alpine.
- [x] **B2 — Schema + migration** (skill `drizzle-schema`)
  - Việc: `schema/users.ts`, `schema/sessions.ts` (sessions + refresh_tokens), `pnpm db:generate --name=auth`. Đọc SQL sinh ra.
  - Test (integration, Postgres thật):
    - email trùng khác hoa thường → 23505 với constraint `users_email_lower_uq`;
    - `search_text` của "Nguyễn Văn A" chứa `nguyen van a`;
    - xoá user → cascade sessions + refresh_tokens.
- [x] **B3 — `PasswordHasher`**
  - Việc:
    - argon2id theo tham số OWASP (m = 19 MiB, t = 2, p = 1);
    - `verify`, `needsRehash`;
    - `verifyDummy()` để email không tồn tại cũng tốn thời gian như sai mật khẩu.
  - Test (unit): hash ≠ mật khẩu; verify đúng/sai; `needsRehash` khi đổi tham số; giới hạn 128 ký tự export thành hằng `PASSWORD_MAX_LENGTH`, còn test chặn ở DTO chuyển sang B6 (lúc đó mới có DTO).
- [x] **B4 — `TokenService`**
  - Việc:
    - ký/verify access JWT (claims `sub`, `sid`, `iss`, `aud`, `exp`);
    - sinh refresh token và hàm hash SHA-256.
  - Test (unit): verify token hợp lệ; sai secret → invalid; token hết hạn → expired; token đúng định dạng nhưng sai `aud` → invalid.
- [x] **B5 — `SessionsService`: tạo phiên, xoay vòng, thu hồi** (skill `db-transactions`)
  - Việc: `create(userId, meta)`, `rotate(refreshToken)` (luồng trên, `FOR UPDATE`), `revoke(sessionId, reason)`, `revokeAll(userId)`.
  - Test (integration):
    - xoay vòng bình thường;
    - token hết hạn;
    - dùng lại trong grace → `ROTATED`, phiên còn sống;
    - dùng lại quá grace → `REUSED` và phiên bị thu hồi.
  - **Test concurrency:** 2 lần `rotate` song song cùng một token → đúng 1 thành công, và chỉ có 1 token mới. **Bỏ `FOR UPDATE` thì test phải đỏ** (ghi kết quả vào "Điều học được").
- [x] **B6 — Register + Login** (skill `nest-endpoint`)
  - Việc:
    - `AuthController`, `AuthService`;
    - DTO: email ≤ 254 ký tự, mật khẩu 8–128, displayName 1–80;
    - email trùng → `AUTH_EMAIL_TAKEN`;
    - login sai → `AUTH_INVALID_CREDENTIALS` (gọi `verifyDummy` khi không có user);
    - rehash khi `needsRehash`;
    - `test/support/factories.ts` (`createUser`, `loginAs`).
  - Test (e2e): 201/200 trả đủ token; email trùng (khác hoa thường) → 409; sai mật khẩu và email không tồn tại → **cùng** 401 + cùng message; body thừa field → 400.
- [x] **B7 — Guard toàn cục** (skill `authorization`)
  - Việc:
    - `JwtAuthGuard` (`APP_GUARD`), `@Public()`, `@CurrentUser()`;
    - khai báo kiểu `req.user`;
    - kiểm tra phiên (Q1);
    - đánh `@Public()` cho health + register/login/refresh;
    - Swagger: route mặc định yêu cầu Bearer, route `@Public()` thì không.
  - Test (e2e): không token / token sai / token hết hạn / phiên đã thu hồi → 401 đúng mã; `/health/*` vẫn public; `/docs-json` thể hiện đúng security.
- [ ] **B8 — Refresh, logout, logout-all**
  - Test (e2e), luồng đầy đủ: login → refresh → access token mới gọi `/me` được → dùng lại refresh cũ (quá grace, giả lập bằng cách lùi `rotated_at` trong DB) → 401 `REUSED` → access token của phiên đó cũng bị 401 `SESSION_REVOKED`.
- [ ] **B9 — `/me` và `/me/sessions`** (`UsersModule`)
  - Test (e2e): `GET/PATCH /me`; liệt kê phiên có cờ `current`; xoá phiên của chính mình → phiên đó 401; xoá phiên của người khác → 404.
- [ ] **B10 — Đóng mốc**
  - Việc:
    - cập nhật `openapi.json`;
    - thử tay trên Swagger UI: Authorize, reload trang vẫn giữ token;
    - đối chiếu `03/04/05/07/09`;
    - ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh (local + CI), có ít nhất 1 test concurrency đã được chứng minh "bỏ lock là đỏ"
- [ ] `openapi.json` có đủ 9 route Auth/Me, security đúng
- [ ] Luồng Swagger UI: đăng ký → Authorize → `/me` → refresh → logout chạy tay được
- [ ] Docker image build được với argon2 (CI)
- [ ] `docs/design/` khớp với code

## Điều sẽ học

- Guard toàn cục (`APP_GUARD`) + `Reflector` + custom decorator (`@Public`, `@CurrentUser`), thứ tự guard → pipe → handler
- Khai báo thêm kiểu (declaration merging) cho `Request` của Express
- Băm mật khẩu đúng cách (argon2id, tham số, rehash), chống dò email bằng thời gian phản hồi
- JWT: claims, `iss`/`aud`, phân biệt lỗi hết hạn với lỗi chữ ký
- Refresh token rotation + phát hiện tái sử dụng, `SELECT … FOR UPDATE` đầu tiên, test concurrency đầu tiên
- pnpm 12 + native addon (`allowBuilds`), prebuild cho musl

## Điều học được / bẫy gặp phải

1. **`pnpm add` một native addon báo lỗi `ERR_PNPM_IGNORED_BUILDS` nhưng vẫn ghi vào `package.json`.** Phải chạy tiếp `pnpm approve-builds argon2`, lệnh này ghi `argon2: true` vào `allowBuilds` và chạy install script. Đừng tưởng lệnh `add` đã thất bại hoàn toàn.
2. **argon2 0.45 có prebuild cho cả glibc lẫn musl** (`argon2.armv8.musl.node`, `argon2.musl.node`). `node-gyp-build` chọn bản phù hợp nên image alpine **không cần** `python3 make g++`. Đã kiểm chứng bằng cách hash/verify trong container `meetnote:local` (linux/arm64, musl).
3. **Script ESM resolve package theo vị trí của file script, không theo `cwd`.** Chạy `node /tmp/x.mjs` với `-w /app` vẫn báo `ERR_MODULE_NOT_FOUND`, vì Node tìm `node_modules` từ `/tmp` đi lên. Script thử nghiệm phải nằm trong cây thư mục có `node_modules`.
4. **Drizzle 0.45 chưa có kiểu `bytea`.** Tự định nghĩa bằng `customType<{ data: Buffer }>` (`schema/column-types.ts`). Driver `pg` trả bytea về `Buffer`, nên so sánh dùng `buf.equals()`, không dùng `===`.
5. **Drizzle ghi tên cột có kèm tên bảng (`"users"."display_name"`) trong generated column và CHECK.** Postgres 18 chấp nhận, đã kiểm chứng bằng integration test. Generated column chỉ được gọi hàm IMMUTABLE, nên phải dùng `f_unaccent()` chứ không dùng `unaccent()`.
6. **Lỗi unique trên _index_ (không phải constraint) vẫn trả `constraint` = tên index** trong lỗi `pg` (vd `users_email_lower_uq`). Nhờ vậy service map được sang mã lỗi cụ thể. Bất biến giữa hai cột viết thành CHECK dạng `(a IS NULL) = (b IS NULL)`, gọn hơn viết OR.
7. **zsh không tách từ biến không có nháy.** `P="npx -y pnpm"; $P format` coi cả chuỗi là tên lệnh, nên lệnh lỗi mà không báo gì vì output đã đẩy vào `/dev/null`. Trong zsh phải viết lệnh trực tiếp, hoặc dùng mảng `P=(npx -y pnpm); $P format`.
8. **Thứ tự tham số trong chuỗi PHC của argon2 0.45 là `m,p,t`** (`$argon2id$v=19$m=19456,p=1,t=2$…`), không phải `m,t,p` như nhiều ví dụ trên mạng. Test không nên khớp nguyên chuỗi, mà nên tách tham số ra rồi so như một tập hợp.
9. **Ném lỗi bên trong `db.transaction` sẽ rollback mọi thứ đã ghi, kể cả lệnh thu hồi phiên.** Khi phát hiện refresh token bị dùng lại, ta muốn _vừa_ thu hồi phiên _vừa_ trả 401. Nếu `throw` trong callback thì việc thu hồi biến mất và kẻ trộm token vẫn dùng tiếp được. Cách làm: callback trả về kết quả dạng union (`ok | invalid | rotated | reused`), commit xong mới `throw`. Test "REUSED → phiên bị thu hồi" kiểm tra đúng điều này.
10. **Kiểm chứng `FOR UPDATE`: bỏ khoá thì test concurrency đỏ** (`['FULFILLED', 'FULFILLED']`, tức một phiên có hai nhánh token). Hai quan sát thêm:
    - Vòng 0 vẫn pass, vòng 1 mới lộ race. Race không xảy ra mọi lần, nên test phải lặp nhiều vòng.
    - Chỉ khoá dòng `sessions` **không đủ**. Request thứ hai đã đọc refresh token (chưa khoá) trước khi phải chờ khoá phiên, nên nó dùng dữ liệu cũ để ghi. Khoá phải nằm ở **đúng dòng chứa điều kiện đang kiểm tra** (`rotated_at`).
11. **Chống email trùng: INSERT rồi bắt lỗi unique, không "SELECT trước rồi INSERT".** Hai request đăng ký cùng email chạy song song sẽ cùng thấy "chưa có". Để unique index `users_email_lower_uq` quyết định, rồi dịch `23505` + đúng tên constraint thành 409 `AUTH_EMAIL_TAKEN` (helper `isUniqueViolation` trong `common/errors/pg-error.ts`).
12. **Query phải viết đúng biểu thức của index.** Index là `lower(email)` thì điều kiện phải là `lower(email) = lower($1)`. Viết `email ILIKE $1` cho kết quả đúng nhưng không dùng được index, nên sẽ quét cả bảng.
13. **Swagger plugin + `classValidatorShim` sinh ràng buộc từ class-validator:** `@MaxLength(254)` thành `maxLength`, `@IsEmail()` thành `format: email`, JSDoc `@example` thành `example`. DTO không cần một decorator `@ApiProperty` nào.
14. **`needsRehash` chỉ dùng được lúc đăng nhập thành công**, vì đó là lúc duy nhất server có mật khẩu gốc. Đã test bằng cách chèn hash tham số yếu vào DB rồi đăng nhập.
15. **Guard toàn cục mặc định đóng.** `APP_GUARD` áp cho mọi controller của app, kể cả controller thuộc module khác và controller chỉ có trong test. Route nào quên `@Public()` sẽ bị chặn, tức là sai theo hướng an toàn. `/docs`, `/docs-json` không đi qua guard vì SwaggerModule đăng ký thẳng lên HTTP adapter, không phải route của Nest.
16. **Swagger: Bearer mặc định + `@Public()` ghi đè bằng `ApiSecurity({})`.** Theo OpenAPI, `security: [{}]` ở cấp operation nghĩa là "không cần xác thực" và ghi đè `security` cấp tài liệu. Dùng API công khai của `@nestjs/swagger`, không phải import vào `dist/constants`.
17. **`JwtAuthGuard` đặt trong `modules/auth/guards/`, không đặt trong `common/auth/`** như skill `authorization` gợi ý ban đầu. Guard cần `TokenService`/`SessionsService`, nên đặt ở `common` thì `common` phụ thuộc ngược vào module nghiệp vụ. Decorator `@Public`/`@CurrentUser` và kiểu `AuthUser` thì vẫn ở `common/auth/`.
18. **Test guard bằng controller thăm dò chỉ có trong test** (`createTestApp({ controllers: [ProbeController] })`). Nhờ vậy test guard độc lập với tính năng, trước khi có `/me`.
