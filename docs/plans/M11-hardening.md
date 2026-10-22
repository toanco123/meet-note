# M11 — Hardening

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-22: ★ cho Q1–Q6)
- **Nhánh:** `m11-hardening`
- **Tài liệu thiết kế liên quan:** [10-roadmap M11](../design/10-roadmap.md), [03-database §7 khoá](../design/03-database.md), [04-authorization §3 điều kiện xem](../design/04-authorization.md), [07-conventions lỗi + env](../design/07-conventions.md), [M3 bài học 5](M3-invites-ownership.md), [M6b bài học 9](M6b-meeting-sharing.md)
- **Ghi chú:** làm khi M6 / M8 / M9 còn hoãn — M11 không phụ thuộc pipeline. Lộ trình liệt kê 7 việc; mốc này chọn 4 việc học được nhiều về Postgres + Nest và chứng minh được bằng test (xem "Ngoài phạm vi").

## Mục tiêu

Cuối mốc:

- **DB không làm request treo vô hạn:** chờ khoá quá lâu, câu lệnh quá lâu, transaction bỏ dở đều bị Postgres cắt và trả lỗi rõ ràng (503 `SERVICE_UNAVAILABLE` + `Retry-After`) thay vì treo tới timeout của client (M3 bài học 5);
- **Rate limit** đúng cả khi chạy nhiều instance api: chặn dò mật khẩu (theo IP **và** theo email), spam đăng ký / mời / upload; trả 429 `RATE_LIMITED` + `Retry-After`;
- **Danh sách meeting có chi phí bị chặn** ở cả ca "thấy nhiều" lẫn "không thấy gì" (M6b bài học 9: ca rỗng 343 ms nếu chỉ viết lại), đo bằng benchmark 100k meeting trước / sau;
- **Quyền tối thiểu ở DB + RLS làm lớp phòng thủ thứ 2:** app không còn kết nối bằng superuser; Postgres tự chặn đọc / ghi chéo tổ chức kể cả khi một query trong code quên `org_id`.

## Ngoài phạm vi

- Presigned upload (đổi lớn luồng M5 đang ổn định), OpenTelemetry (cần hạ tầng xem trace), nâng Node 26 (chờ Node 26 lên LTS) — giữ trong lộ trình, làm ở mốc sau nếu muốn.
- RLS theo **từng người xem** (đưa `meetingVisibleTo` vào policy): điều kiện xem vẫn ở một chỗ trong code (04 §3); RLS ở mốc này chỉ giữ **ranh giới tổ chức**.
- WAF / chống DDoS tầng mạng — việc của reverse proxy / hạ tầng.

## Quyết định cần duyệt

| #   | Câu hỏi                                    | Đề xuất ★                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Phương án khác                                                                                                                                                                                                                                     |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Đặt timeout của Postgres ở đâu, bao nhiêu? | ★ Trong cấu hình pool (`pg` gửi lúc kết nối, áp cho MỌI connection của tiến trình), có env để chỉnh: api `lock_timeout` 3 s, `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 30 s; worker cùng `lock_timeout` + idle, `statement_timeout` 60 s (job theo lô). Lỗi `55P03` (chờ khoá) / `57014` (câu lệnh bị huỷ) → **503 `SERVICE_UNAVAILABLE` + `Retry-After: 1`** (tạm thời, thử lại được). Job purge giữ `set_config('lock_timeout')` riêng như hiện tại                                                                                                                                                                                | `ALTER ROLE … SET` (nằm ở DB, code / test không thấy); `SET LOCAL` từng transaction (dễ quên); map sang 409 / 500 (409 sai nghĩa "xung đột dữ liệu", 500 làm client không biết nên thử lại)                                                        |
| Q2  | Rate limit bằng gì?                        | ★ **`@nestjs/throttler`** (guard + `@Throttle` / `@SkipThrottle` + header) với **storage Redis tự viết bằng Lua** — một script tăng đếm + đặt hạn + kiểm chặn trong MỘT lệnh nguyên tử, đúng khi nhiều instance. Khoá: người đã đăng nhập theo `userId`, route công khai theo IP; `trust proxy` theo env số tầng proxy                                                                                                                                                                                                                                                                                                                                     | Tự viết cả guard (học thêm nhưng phải tự làm decorator / header / bỏ qua); storage có sẵn trên npm (thêm dependency, không học được Lua / tính nguyên tử); chỉ đặt ở reverse proxy (không biết user / email)                                       |
| Q3  | Giới hạn cụ thể?                           | ★ Mặc định 300 request / phút / người dùng (hoặc IP). Riêng: đăng nhập **5 / phút theo (IP, email)** + 30 / phút theo IP (chặn dò một tài khoản từ nhiều IP và dò nhiều tài khoản từ một IP); đăng ký 10 / giờ / IP; refresh 30 / phút / IP; chấp nhận link mời 20 / phút / người; tạo link mời và khởi tạo upload 60 / giờ / người. Health / docs / realtime handshake bỏ qua                                                                                                                                                                                                                                                                             | Một giới hạn chung cho mọi route (không chặn được dò mật khẩu); giới hạn theo tổ chức (chưa cần)                                                                                                                                                   |
| Q4  | Viết lại danh sách meeting thế nào?        | ★ **Sinh ứng viên từ các luồng keyset có trần rồi lọc lại bằng `meetingVisibleTo`**: (a) meeting của mình; (b) với MỖI kênh người xem thấy (`LATERAL`), `limit + 1` meeting mới nhất của kênh đó; (c) meeting không chủ nếu là Admin. Gộp, bỏ trùng, sắp, cắt trang. Chi phí ≈ số kênh thấy được × trang, không phụ thuộc tổng số share; ca rỗng dừng ngay. Cần chép `recorded_at` vào `meeting_shares` + index `(channel_id, recorded_at DESC, meeting_id DESC)`, cập nhật trong CÙNG transaction khi sửa `recordedAt`. **Đo trước khi chốt**: nếu không thắng cả 3 ca thì giữ cách cũ và ghi lại số đo                                                   | Bảng `meeting_viewers` phi chuẩn hoá (đọc O(trang) nhưng mỗi thay đổi thành viên / share ghi lại hàng loạt, dễ lệch); giữ nguyên (trần ~15–30 ms ở 100k, tăng theo dữ liệu)                                                                        |
| Q5  | Role của Postgres?                         | ★ Ba vai: `meetnote` (chủ schema, chạy migration — như hiện tại); **`meetnote_app`** (api: chỉ SELECT / INSERT / UPDATE / DELETE, không DDL, không superuser, **bị RLS**); **`meetnote_worker`** (worker: như app nhưng `BYPASSRLS` — job chạy xuyên tổ chức: purge, fan-out). Migration tạo role `NOLOGIN` + GRANT + default privileges (không có mật khẩu trong git); user đăng nhập (`LOGIN PASSWORD` từ env) do bước provision của `migrate` / test setup tạo                                                                                                                                                                                          | Một role cho cả api + worker (worker phải tự đặt ngữ cảnh tổ chức cho từng job); giữ superuser (RLS vô hiệu — superuser LUÔN bỏ qua RLS, kể cả `FORCE`)                                                                                            |
| Q6  | RLS áp thế nào?                            | ★ Policy `org_id = current_setting('app.org_id', true)::uuid` (+ `FORCE ROW LEVEL SECURITY`) trên các bảng chỉ đọc trong ngữ cảnh một tổ chức: `channels`, `channel_members`, `meetings`, `meeting_shares`, `uploads` (sau này transcript / summary / report cùng mẫu). Ngữ cảnh: `OrgMemberGuard` ghi `orgId` vào `AsyncLocalStorage`; pool đặt `app.org_id` **mỗi lần lấy connection** (kể cả đặt rỗng khi không có ngữ cảnh → không rò giữa các request). Chỗ không qua route `/orgs/:orgId` (realtime `subscribe`, …) gọi tường minh `runInOrg(orgId, fn)` — kiểm kê đủ ở bước đầu của B7. Thiếu ngữ cảnh → **không thấy dòng nào** (an toàn mặc định) | RLS cả bảng `organizations` / `organization_members` (danh sách "org của tôi" / đăng nhập sẽ vỡ); đặt ngữ cảnh bằng transaction cho mọi request (giữ connection suốt request — upload stream S3 sẽ giữ connection hàng phút); chỉ làm Q5, chưa RLS |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- Header rate limit theo chuẩn IETF draft: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; 429 có `Retry-After` (giây). Trùng tên với `@nestjs/throttler` thì dùng của thư viện.
- Đếm theo **cửa sổ cố định** (fixed window, như storage mặc định của throttler) — đơn giản, đủ cho chặn dò. Ghi rõ điểm yếu "dồn ở mép cửa sổ" (tối đa 2× giới hạn trong 2 cửa sổ liền nhau).
- Redis sập → rate limit **cho qua** (fail-open, log lỗi): không để mất Redis làm sập cả đăng nhập. Hệ quả: lúc Redis sập không có rate limit.
- Benchmark đặt ở `scripts/bench/` (không chạy trong CI), dùng DB tạm tự tạo / tự xoá, in bảng số đo vào plan.
- Chi phí RLS (+1 round-trip mỗi lần lấy connection) **đo và ghi lại**, không đoán.

## Thay đổi thiết kế

- **03-database:** cột `meeting_shares.recorded_at` + index (Q4); các role + GRANT (Q5); bảng có RLS + policy + `app.org_id` (Q6); `lock_timeout` / `statement_timeout` / `idle_in_transaction_session_timeout` vào §7.
- **05-api:** 429 + header rate limit, giới hạn từng nhóm route (Q3); 503 + `Retry-After` khi DB bận (Q1).
- **07-conventions:** env mới (`DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_TX_TIMEOUT_MS`, `TRUST_PROXY_HOPS`, URL / mật khẩu role app + worker); mã lỗi 503 cho DB bận.
- **02-architecture:** ngữ cảnh tổ chức qua `AsyncLocalStorage` → `app.org_id` (Q6); api / worker / migrate dùng ba role khác nhau.
- **Dependency mới:** `@nestjs/throttler` (theo skill `add-dependency` ở B2).

## Các bước

- [ ] **B1 — Timeout của Postgres + map lỗi**
  - Việc: 3 timeout vào pool qua env (Q1); `AllExceptionsFilter` map `55P03` / `57014` → 503 + `Retry-After`; connection bị cắt vì idle trong transaction không làm sập tiến trình (pool `'error'` đã có listener).
  - Test (integration / e2e, Postgres thật): một connection của test giữ `FOR UPDATE` → request cần dòng đó trả **503 sau ~`lock_timeout`** (không treo); `pg_sleep` dài hơn `statement_timeout` → 503; transaction bỏ dở quá `idle_in_transaction_session_timeout` → session bị cắt, pool vẫn phục vụ request sau. Tái hiện đúng ca M3 bài học 5 (dùng `this.db` trong transaction có khoá) → giờ lỗi thay vì treo. Đột biến bỏ timeout → test hết giờ (đỏ).
- [ ] **B2 — Storage rate limit trên Redis (Lua)**
  - Việc: cài `@nestjs/throttler`; `RedisThrottlerStorage` — một Lua script: `INCR`, đặt `PEXPIRE` lần đầu, đặt khoá chặn khi vượt; trả `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }`; fail-open khi Redis lỗi.
  - Test (integration, Redis thật): 50 lần tăng SONG SONG với giới hạn 10 → đúng 10 lần được qua; hết cửa sổ → đếm lại; hai storage (hai "instance") dùng chung đếm. Đột biến tách thành `INCR` rồi `EXPIRE` hai lệnh rời (không Lua) → lộ khoá không hạn khi lệnh 2 lỗi; đột biến đếm trong bộ nhớ → test hai instance đỏ.
- [ ] **B3 — Áp rate limit vào route**
  - Việc: `ThrottlerGuard` toàn cục (sau `JwtAuthGuard` để biết `userId`), khoá theo user / IP; giới hạn riêng theo Q3 (đăng nhập theo cả (IP, email)); `@SkipThrottle` cho health / docs; `trust proxy` theo `TRUST_PROXY_HOPS`; Swagger khai báo 429.
  - Test (e2e): đăng nhập sai 5 lần cùng email từ 2 IP khác nhau (`X-Forwarded-For` + trust proxy) → lần 6 bị 429 dù đổi IP; 429 có `Retry-After` + body lỗi chuẩn; hai app Nest cùng Redis chia sẻ đếm; không đặt trust proxy thì `X-Forwarded-For` giả KHÔNG đổi được IP. Bảng giới hạn từng route.
- [ ] **B4 — Benchmark danh sách meeting (đo baseline)**
  - Việc: `scripts/bench/meeting-list.ts`: tạo DB tạm từ migration thật, sinh 100k meeting / ~120k share / 200 kênh / 10k thành viên kênh như M6b; đo `EXPLAIN (ANALYZE, BUFFERS)` 3 hồ sơ người xem: **dày** (thấy nhiều), **thưa** (vài kênh riêng tư), **rỗng** (thành viên mới), trang 1 và trang sâu; xoá DB tạm.
  - Test: không phải test — kết quả baseline ghi vào plan (bảng số).
- [ ] **B5 — Viết lại danh sách meeting (nếu số đo thắng)**
  - Việc: migration `meeting_shares.recorded_at` (backfill) + index; ghi `recorded_at` khi share; sửa `recordedAt` của meeting → cập nhật share trong cùng transaction; query mới (Q4), `meetingVisibleTo` vẫn là bộ lọc cuối.
  - Test: toàn bộ e2e danh sách M6b phải xanh nguyên; thêm: meeting share vào 3 kênh hiện 1 lần; sửa `recordedAt` → thứ tự đổi đúng ở cả danh sách org lẫn kênh; phân trang qua nhóm trùng `recorded_at`. Đột biến bỏ bước lọc `meetingVisibleTo` / không cập nhật `recorded_at` của share → đỏ. Chạy lại benchmark, ghi bảng trước / sau.
- [ ] **B6 — Role tối thiểu quyền**
  - Việc: migration tạo `meetnote_app` / `meetnote_worker` (`NOLOGIN`) + GRANT + `ALTER DEFAULT PRIVILEGES`; provision user đăng nhập từ env (compose `migrate`, test global setup); api / worker kết nối bằng role riêng; `migrate` vẫn dùng chủ schema.
  - Test: role app không `CREATE TABLE` / `DROP` / `TRUNCATE` được (`42501`); toàn bộ e2e chạy dưới role app vẫn xanh (chứng minh GRANT đủ); bảng tạo ở migration SAU vẫn dùng được (default privileges).
- [ ] **B7 — RLS ranh giới tổ chức**
  - Việc: kiểm kê mọi chỗ đọc / ghi 5 bảng ngoài route `/orgs/:orgId` → `runInOrg`; `OrgContext` (`AsyncLocalStorage`) + đặt `app.org_id` mỗi lần lấy connection; migration `ENABLE` + `FORCE ROW LEVEL SECURITY` + policy.
  - Test: không ngữ cảnh → 0 dòng; giả lập bug "repository quên `org_id`" (query trực tiếp theo id meeting của org khác trong ngữ cảnh org mình) → không thấy, INSERT chéo bị `WITH CHECK` chặn; ngữ cảnh KHÔNG rò sang request sau trên cùng connection (pool `max: 1`); worker (`BYPASSRLS`) chạy fan-out / purge xuyên tổ chức bình thường; toàn bộ e2e xanh. Đột biến không đặt lại ngữ cảnh khi lấy connection → test rò đỏ. Đo chi phí thêm mỗi request.
- [ ] **B8 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu, chạy tay trên Compose (3 role, rate limit, timeout), ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI — **chạy dưới role app, không phải superuser**
- [ ] Không còn đường nào làm request treo vô hạn vì DB; rate limit đúng khi nhiều instance
- [ ] Số đo danh sách meeting trước / sau ghi trong plan
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code

## Điều sẽ học

- Timeout phía Postgres (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`) khác timeout phía client thế nào; lỗi nào nên trả 503 để client thử lại
- Rate limit phân tán: tính nguyên tử bằng Lua, cửa sổ cố định vs trượt, khoá theo nhiều chiều (IP, email, user), `trust proxy` và giả mạo `X-Forwarded-For`
- Đọc kế hoạch thực thi trên dữ liệu đủ lớn; đổi cách viết SQL để chi phí bị chặn; phi chuẩn hoá có kiểm soát (một cột chép + cập nhật cùng transaction)
- Quyền tối thiểu ở DB; RLS: `FORCE`, superuser / `BYPASSRLS`, `current_setting(…, true)`, ngữ cảnh theo connection trong pool và bẫy rò ngữ cảnh

## Điều học được / bẫy gặp phải

(Ghi trong lúc làm)
