# M5 — Upload

- **Trạng thái:** Đang làm (plan đã duyệt 2026-10-19: ★ cho Q1–Q6)
- **Nhánh:** `m5-upload`
- **Tài liệu thiết kế liên quan:** [01-overview D3, D4](../design/01-overview.md), [03-database §4, `idempotency_keys`, §7](../design/03-database.md), [05-api Meetings](../design/05-api.md), [06-flows §1.1](../design/06-flows.md), [10-roadmap M5](../design/10-roadmap.md)

## Mục tiêu

Cuối mốc, một thành viên tổ chức upload được **file ghi âm lớn (tới 2 GB)** theo từng phần 8 MB:

- **init**: khai báo file, server mở S3 multipart, trả `uploadId`, `chunkSize`, `totalParts`;
- **PUT part**: gửi từng phần, có thể song song. Server **stream thẳng request vào S3, không đọc cả phần vào RAM**;
- **mất mạng giữa chừng**: hỏi `GET /uploads/:id` để biết phần nào đã có, gửi tiếp phần thiếu (**resume**);
- **complete**: ghép file trên S3, tạo **meeting ở trạng thái `queued`**, đẩy job `meeting.preprocess` vào queue (worker xử lý ở M6);
- **huỷ** upload, và **logic dọn** upload bỏ dở (abort multipart để S3 không giữ các phần mồ côi).

Gọi lại an toàn ở mọi bước: PUT cùng một phần hai lần, complete hai lần, init lặp lại với cùng `Idempotency-Key` đều không tạo dữ liệu trùng.

Tiêu chí thật (roadmap): **upload file 500 MB, ngắt giữa chừng, resume, complete → meeting `queued`**, chạy tay trên Docker Compose.

## Ngoài phạm vi

- Xử lý audio (ffmpeg), Whisper, tóm tắt, chuyển trạng thái meeting sau `queued` (M6).
- Chia sẻ meeting vào kênh, quyền xem meeting theo kênh (04 §3), danh sách / sửa / xoá meeting (M6).
- **Lên lịch** chạy job dọn upload hết hạn: như purge kênh ở M4, chỉ viết logic + test, lên lịch ở M6 khi worker có processor thật.
- Tiến độ upload realtime (M7). Presigned URL (mốc hardening, D4).
- Kiểm tra `sha256` toàn file: client gửi lúc init, **worker kiểm tra ở M6** sau khi tải file về (06-flows §1.1).

## Quyết định cần duyệt

| #   | Câu hỏi                                                                    | Đề xuất ★                                                                                                                                                                                                                                                                                                                                                                                                          | Phương án khác                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Người upload **rời / bị gỡ khỏi tổ chức** thì meeting và upload dở ra sao? | ★ **Meeting ở lại tổ chức**: `meetings.owner_id` thành `NULL` bằng `ON DELETE SET NULL (owner_id)` (cú pháp có từ PostgreSQL 15, chỉ null **một cột** trong composite FK, giữ `org_id`). Meeting đã share vào kênh vẫn xem được; OrgAdm quản lý. **Upload dở** thì để nguyên tới khi hết hạn, job dọn sẽ abort (FK của upload trỏ `users`, không trỏ thành viên org, để cascade không xoá dòng mà S3 còn giữ phần) | Chặn rời org khi còn meeting (409, giống kênh) — nặng với người có nhiều meeting. Tự chuyển meeting cho Owner tổ chức. Thiết kế cũ ghi `RESTRICT` nhưng chưa chốt hướng xử lý                                                        |
| Q2  | **Complete** gọi S3 `CompleteMultipartUpload` trong transaction không?     | ★ **Có, giữ `FOR UPDATE` dòng upload trong lúc gọi S3**, đặt timeout 30 s cho lời gọi S3. Đúng như thiết kế 06-flows; khoá chỉ chặn chính upload đó, và hai complete song song tự xếp hàng → đúng một meeting                                                                                                                                                                                                      | **Hai pha:** `UPDATE … SET status='completing' WHERE status='initiated'` → gọi S3 ngoài transaction → transaction ghi meeting. Không giữ connection lúc gọi mạng, nhưng cần trạng thái `completing` + khôi phục khi crash giữa chừng |
| Q3  | `Idempotency-Key` làm tới đâu?                                             | ★ **Cơ chế chung**: bảng `idempotency_keys` + interceptor `@Idempotent()` (lưu response, gọi lại cùng key → trả lại đúng response cũ; cùng key khác nội dung → 422; đang xử lý → 409). Áp cho **init** (vốn không idempotent: gọi lại sẽ mở multipart mới). **Complete** tự idempotent theo trạng thái upload, vẫn nhận header để client dùng một kiểu                                                             | Chỉ dựa vào idempotent tự nhiên (complete theo trạng thái), init không chống trùng                                                                                                                                                   |
| Q4  | Test với S3 thế nào?                                                       | ★ **RustFS thật qua Testcontainers** (thêm container thứ 3 vào global setup, như Postgres / Redis). Bắt được hành vi thật: phần < 5 MB bị S3 từ chối khi complete, checksum, stream có `ContentLength`                                                                                                                                                                                                             | Fake in-memory cho e2e, chỉ test adapter với RustFS — nhanh hơn nhưng e2e không chạm hành vi thật của S3                                                                                                                             |
| Q5  | M5 có enqueue job `meeting.preprocess` không (processor ở M6)?             | ★ **Có**, sau commit, `jobId = meeting.preprocess.{meetingId}.a1`, queue `default`. Job nằm chờ trong Redis tới M6. Test kiểm tra job tồn tại đúng ID và **chỉ có sau commit**                                                                                                                                                                                                                                     | Để M6 mới enqueue — M5 gọn hơn nhưng mất bài "enqueue sau commit"                                                                                                                                                                    |
| Q6  | API meeting trong M5?                                                      | ★ Chỉ `GET /meetings/:meetingId` cho **chủ meeting** (để client hỏi trạng thái sau complete). Danh sách, sửa, xoá, quyền xem theo kênh làm ở M6                                                                                                                                                                                                                                                                    | Làm đủ CRUD meeting ngay M5                                                                                                                                                                                                          |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- **Giới hạn:** 1 byte – 2 GiB, `chunkSize` cố định **8 MiB** (S3 yêu cầu mỗi phần ≥ 5 MiB trừ phần cuối; 2 GiB / 8 MiB = 256 phần, dưới trần 10 000). Upload hết hạn sau **24 giờ**.
- **Định dạng cho phép (theo `mimeType` client khai):** `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, `audio/x-wav`, `audio/webm`, `audio/ogg`, `audio/flac`, `video/mp4`, `video/webm` (bản ghi Zoom / Meet là video, ffmpeg tách audio ở M6). `mimeType` chỉ là lời khai của client; **định dạng thật do ffprobe kiểm ở M6**.
- **Object key không chứa dữ liệu người dùng:** `orgs/{orgId}/uploads/{uploadId}/source`. Tên file gốc chỉ lưu trong DB (tránh ký tự lạ, path traversal trong key).
- **Ai được làm gì:** mọi thành viên tổ chức được init. Mọi thao tác trên một upload **chỉ người tạo** làm được; người khác (kể cả OrgAdm) nhận **404** (tài nguyên ẩn).
- **Không ghi audit** cho upload / meeting: audit log dành cho thao tác quản trị (M3).

## Thay đổi thiết kế

### Bảng (sửa `03-database.md` §4)

| Bảng               | Cột chính                                                                                                                                                                                                                | Ràng buộc / index                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads`          | id, org_id, user_id, filename, mime_type, size_bytes bigint, sha256, chunk_size, total_parts, title, recorded_at, object_key, s3_upload_id, status, meeting_id, expires_at, storage_aborted_at, created_at, completed_at | CHECK status `initiated \| completed \| aborted \| expired`; CHECK size 1 B – 2 GiB; CHECK sha256 là 64 ký tự hex<br>FK org → `organizations`, user → `users`<br>index dọn dẹp `(expires_at) WHERE status = 'initiated'`<br>index abort lại `(id) WHERE status IN ('aborted','expired') AND storage_aborted_at IS NULL` |
| `upload_parts`     | upload_id, part_number, size_bytes, etag, created_at                                                                                                                                                                     | PK `(upload_id, part_number)`, FK upload ON DELETE CASCADE, CHECK part_number 1–10000                                                                                                                                                                                                                                   |
| `meetings`         | như thiết kế 03 §4 (tạo đủ cột cho M6: status, attempt, duration_ms, language, failure_*, object keys…)                                                                                                                  | `UNIQUE (id, org_id)`; FK `(org_id, owner_id)` → `organization_members` **ON DELETE SET NULL (owner_id)** (Q1, có thể phải viết SQL tay nếu Drizzle chưa sinh được cú pháp có danh sách cột); CHECK status; index `(org_id, owner_id, created_at DESC, id) WHERE deleted_at IS NULL`                                    |
| `idempotency_keys` | user_id, key, method, path, request_hash, status (`processing \| completed`), response_status, response_body jsonb, created_at, expires_at                                                                               | PK `(user_id, key)`; index `(expires_at)` cho dọn dẹp                                                                                                                                                                                                                                                                   |

`storage_aborted_at` (mới so với thiết kế): upload bị huỷ / hết hạn được đánh dấu trong DB **trước**, gọi `AbortMultipartUpload` **sau, ngoài transaction**. Gọi S3 lỗi thì cột này còn `NULL` → lần dọn sau thử lại. Không bao giờ để phần mồ côi nằm mãi trên S3.

### API (sửa `05-api.md` Meetings)

Prefix `/v1/orgs/:orgId`:

| Method | Path                                   | Ai gọi           | Ghi chú                                                                                                                                              |
| ------ | -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/uploads`                             | Thành viên org   | `{ filename, mimeType, sizeBytes, sha256, title, recordedAt }` → 201 `{ uploadId, chunkSize, totalParts, expiresAt }`. Header `Idempotency-Key` (Q3) |
| GET    | `/uploads/:uploadId`                   | Người tạo        | Trạng thái + danh sách phần đã nhận `[{ partNumber, sizeBytes }]` để resume                                                                          |
| PUT    | `/uploads/:uploadId/parts/:partNumber` | Người tạo        | Body `application/octet-stream`, bắt buộc `Content-Length` đúng kích thước phần. Idempotent. → `{ partNumber, sizeBytes }`                           |
| POST   | `/uploads/:uploadId/complete`          | Người tạo        | Thiếu phần → 409 kèm danh sách phần thiếu. Gọi lại khi đã xong → trả lại đúng meeting cũ. → 201 meeting (`status: queued`)                           |
| DELETE | `/uploads/:uploadId`                   | Người tạo        | Huỷ: đánh dấu `aborted`, abort multipart. 204. Gọi lại → 204                                                                                         |
| GET    | `/meetings/:meetingId`                 | Chủ meeting (M5) | Trạng thái meeting (Q6). M6 mở rộng theo quyền xem 04 §3                                                                                             |

### Mã lỗi mới (thêm vào catalog `Errors` + 07)

| Mã                          | HTTP | Khi nào                                                                          |
| --------------------------- | ---- | -------------------------------------------------------------------------------- |
| `UPLOAD_PART_SIZE_MISMATCH` | 400  | `Content-Length` khác kích thước phần mong đợi (phần cuối có kích thước riêng)   |
| `UNSUPPORTED_MEDIA_TYPE`    | 415  | PUT part không phải `application/octet-stream`                                   |
| `PAYLOAD_TOO_LARGE`         | 413  | (đã có) body vượt kích thước phần — trả **trước khi** đọc hết body               |
| `UPLOAD_EXPIRED`            | 410  | upload quá hạn 24 giờ                                                            |
| `UPLOAD_NOT_ACTIVE`         | 409  | PUT part / complete khi upload đã huỷ / hết hạn / đã xong (trừ complete gọi lại) |
| `UPLOAD_INCOMPLETE`         | 409  | complete khi còn thiếu phần; `details` liệt kê số phần thiếu                     |
| `IDEMPOTENCY_KEY_REUSED`    | 422  | cùng key nhưng nội dung request khác lần đầu                                     |
| `IDEMPOTENCY_IN_PROGRESS`   | 409  | cùng key, request đầu còn đang chạy                                              |

## Dependency mới

| Package              | Phiên bản (tra 2026-10-14)                      | Ghi chú                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aws-sdk/client-s3` | `3.1151.0` (latest, phát hành 13/10; Node ≥ 20) | Tra lại lúc cài (B2) theo skill `add-dependency`. Bản quá mới mà `minimumReleaseAge` của pnpm chặn thì dùng bản trước (`3.1150.0`), không thêm ngoại lệ. **Rủi ro cần kiểm ở B2:** SDK v3 bản mới tự tính checksum (CRC32) cho mọi request — một số server tương thích S3 không chấp nhận; nếu RustFS từ chối thì cấu hình `requestChecksumCalculation: 'WHEN_REQUIRED'` và ghi vào 09-versions |

Không cần `@aws-sdk/lib-storage`: tự làm multipart là chính nội dung cần học (D4).

## Bố cục code dự kiến

- `src/infra/storage/`: `ObjectStorage` (interface, trong `storage.types.ts`) + adapter S3 + `StorageModule` (token `OBJECT_STORAGE`). Module domain chỉ biết interface, không biết SDK.
- `src/modules/uploads/`: controller, service (init / part / complete / huỷ), service dọn dẹp, repository (upload + part). Theo quy tắc thư mục vai trò: từ 2 file cùng vai trò thì vào `services/`, `repositories/`…
- `src/modules/meetings/`: repository + service tạo meeting, controller `GET /meetings/:id`. Tách sẵn để M6 mở rộng.
- `src/common/idempotency/`: bảng + interceptor `@Idempotent()` dùng chung.
- Biến môi trường mới: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (RustFS cần path-style). Thêm vào `.env.example`, `env.validation.ts`, `compose.yaml`.

## Các bước

Mỗi bước = 1 commit, chạy được và có test. Mỗi chỗ khoá / chỗ có thể chạy trùng đều có test race + đột biến.

- [x] **B1 — Schema + migration**
  - Việc: `uploads`, `upload_parts`, `meetings`, `idempotency_keys` theo bảng trên. Khoá ngoại `ON DELETE SET NULL (owner_id)` có thể phải viết SQL tay (`db:generate --custom`).
  - Test (integration): CHECK kích thước / sha256 / status; part_number ngoài 1–10000 → 23514; xoá thành viên org → meeting còn, `owner_id` NULL nhưng **`org_id` giữ nguyên** (chứng minh khác với `SET NULL` cả hai cột); partial index dọn dẹp được dùng (EXPLAIN).
- [x] **B2 — Storage module (S3 / RustFS)**
  - Việc: cài `@aws-sdk/client-s3`, `ObjectStorage` (create / uploadPart(stream, length) / complete / abort / head), adapter S3, config env, tạo bucket ở dev / test. Thêm RustFS vào Testcontainers global setup và `compose.yaml` cho app.
  - Test (integration, RustFS thật): multipart 2 phần → complete → `head` đúng kích thước; phần đầu < 5 MiB → S3 từ chối khi complete (ghi lại mã lỗi thật); abort hai lần không lỗi; upload phần bằng **stream** có `ContentLength` (không buffer).
- [ ] **B3 — Init / trạng thái / huỷ upload**
  - Việc: `POST /uploads`, `GET /uploads/:id`, `DELETE /uploads/:id`. Thứ tự init: **mở multipart trên S3 trước, rồi INSERT**; INSERT lỗi thì **abort ngay** (hành động bù trừ), không để multipart mồ côi.
  - Test (e2e): validate (0 byte, > 2 GiB, mime lạ, sha256 sai) → 400; `totalParts` / `chunkSize` đúng; người khác (kể cả OrgAdm) → 404; huỷ → 204, gọi lại → 204. Integration: giả INSERT lỗi → multipart đã bị abort.
- [ ] **B4 — PUT part: stream, không buffer**
  - Việc: đọc `req` như stream, `pipeline` sang `UploadPart` với `ContentLength`; đếm byte, vượt thì huỷ ngay; client ngắt giữa chừng → **huỷ lời gọi S3** (`AbortController`), không lưu phần; upsert `upload_parts` (`ON CONFLICT DO UPDATE`).
  - Test (e2e): phần đúng → 200; gửi lại cùng phần → 200, không trùng; `Content-Length` sai → 400; quá kích thước → 413 **trước khi** đọc hết body; không phải octet-stream → 415; upload hết hạn → 410; đã huỷ → 409; **ngắt kết nối giữa phần** → không có dòng `upload_parts`, gửi lại phần đó → 200; 4 phần song song.
- [ ] **B5 — Complete → meeting `queued` + enqueue sau commit**
  - Việc: transaction `FOR UPDATE` upload → đủ phần? → S3 complete (timeout 30 s, Q2) → INSERT meeting → upload `completed` → COMMIT → enqueue `meeting.preprocess.{id}.a1`. Gọi lại khi đã `completed` → trả meeting cũ. `GET /meetings/:id` cho chủ (Q6).
  - Test (e2e): thiếu phần → 409 kèm danh sách; complete → 201, meeting `queued`, job có trong Redis đúng `jobId`; gọi lại → cùng meeting, không thêm job.
  - **Race:** 2 complete song song → **đúng 1 meeting**. Đột biến bỏ `FOR UPDATE` → 2 meeting hoặc lỗi S3 lọt ra.
  - **Enqueue sau commit:** ép lỗi sau khi INSERT meeting (transaction rollback) → **không có job** trong Redis. Đột biến enqueue trong transaction → job "ma" trỏ tới meeting không tồn tại.
- [ ] **B6 — `Idempotency-Key` dùng chung**
  - Việc: bảng + interceptor `@Idempotent()`: `INSERT … ON CONFLICT DO NOTHING` giữ chỗ (`processing`) → chạy handler → lưu response; handler lỗi → xoá chỗ giữ để client thử lại. Áp cho init (Q3).
  - Test (e2e): cùng key + cùng body → cùng `uploadId`, **chỉ 1 multipart** trên S3; cùng key + body khác → 422; header thiếu → chạy bình thường; key của user A không ảnh hưởng user B.
  - **Race:** 2 init song song cùng key → 1 thành công, 1 nhận 409 `IDEMPOTENCY_IN_PROGRESS` (hoặc nhận lại response nếu tới sau khi xong). Đột biến "SELECT trước rồi mới INSERT" → 2 upload.
- [ ] **B7 — Dọn upload hết hạn (logic, lên lịch ở M6)**
  - Việc: `expireBatch`: transaction ngắn, `FOR UPDATE SKIP LOCKED` lấy lô upload `initiated` quá hạn → đánh dấu `expired`; **ra ngoài transaction** mới gọi `AbortMultipartUpload`, thành công thì ghi `storage_aborted_at`. Lô sau thử lại những upload `aborted` / `expired` còn `storage_aborted_at IS NULL` (gồm cả huỷ thủ công bị lỗi S3). Kèm dọn `idempotency_keys` hết hạn.
  - Test (integration, RustFS thật): upload quá hạn → `expired` + multipart không còn trên S3; S3 lỗi (adapter giả lỗi) → `storage_aborted_at` NULL, lần sau thử lại thành công; 2 worker song song lấy 2 lô khác nhau (như purge kênh). Đột biến bỏ `SKIP LOCKED` → `pg:55P03`.
- [ ] **B8 — Đóng mốc**
  - Việc: `openapi.json`, đối chiếu tài liệu bằng script (như M4), chạy tay trên Docker Compose: **file 500 MB**, 4 phần song song, ngắt giữa chừng, resume qua `GET /uploads/:id`, complete → meeting `queued`; đo bộ nhớ container `api` lúc upload (`docker stats`) để thấy không bị nhân theo kích thước file. Ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI (có RustFS trong Testcontainers); mọi race test đã được đột biến
- [ ] Upload 500 MB, ngắt, resume, complete → meeting `queued` (chạy tay trên Compose), bộ nhớ `api` không tăng theo kích thước file
- [ ] Không có đường nào để lại multipart mồ côi trên S3: init lỗi giữa chừng, huỷ, hết hạn, S3 lỗi lúc abort
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code (03 §4 + §7, 05 Meetings, 07 mã lỗi, 09 phiên bản)

## Điều sẽ học

- Stream & backpressure trong Node: `pipeline`, vì sao không `await req.arrayBuffer()`; giới hạn body theo route; huỷ việc đang chạy khi client ngắt (`AbortController`)
- S3 multipart: kích thước phần tối thiểu, ETag, complete / abort, phần mồ côi tốn dung lượng
- Idempotency hai kiểu: **tự nhiên theo trạng thái** (complete) và **bằng khoá** (`Idempotency-Key`), cùng race của chính cơ chế idempotency
- Hành động bù trừ khi một bước nằm ngoài DB (S3) thành công còn bước trong DB thất bại
- Enqueue **sau commit** và vì sao; `jobId` có tên bước + lần chạy
- `ON DELETE SET NULL (cột)` của PostgreSQL 15+ với composite FK

## Điều học được / bẫy gặp phải

1. **`ON DELETE SET NULL` trên composite FK null CẢ hai cột.** Đã thử trên Postgres thật trước khi viết schema: với FK `(org_id, owner_id)`, Postgres tự sinh `UPDATE … SET "org_id" = NULL, "owner_id" = NULL` → `org_id NOT NULL` vỡ (`23502`) → **xoá thành viên khỏi org thất bại**, không chỉ "meeting mất chủ". Cần `ON DELETE SET NULL (owner_id)` (PostgreSQL 15+). Drizzle không sinh được dạng có danh sách cột nên FK này nằm ở migration viết tay `0007_meetings_owner_fk.sql`, không khai trong schema TS. Đột biến đổi về dạng thường → test "gỡ chủ khỏi org" đỏ đúng `23502` kèm câu UPDATE Postgres sinh ra.
2. **Khoá ngoại cần index ở phía THAM CHIẾU, và index đó không được partial.** Xoá một thành viên → Postgres tìm mọi meeting `(org_id, owner_id)` của người đó, kể cả đã xoá mềm. Postgres **không tự tạo** index cho phía tham chiếu. Index "meeting của tôi" ban đầu viết partial `WHERE deleted_at IS NULL` → không dùng được cho lần tìm này → quét cả bảng mỗi lần gỡ thành viên. Đã bỏ partial (số dòng xoá mềm ít), một index phục vụ cả hai việc. Phát hiện nhờ **đọc lại SQL drizzle-kit sinh ra** trước khi dùng; migration chưa commit nên xoá rồi sinh lại cho sạch thay vì chồng thêm migration sửa index.
3. **Ràng buộc "dẫn xuất" để DB tự kiểm**: `total_parts = (size + chunk - 1) / chunk` (ceil bằng số nguyên), `status = 'completed'` ⇔ có `meeting_id` + `completed_at`. Code có bug tính sai số phần thì DB chặn ngay lúc INSERT.
4. **`upload_parts` không mang `org_id`** dù quy ước "bảng con có composite FK theo org": quy ước đó để chặn ghép chéo tổ chức khi một dòng tham chiếu từ HAI phía (vd `channel_members` → kênh + thành viên org). `upload_parts` chỉ có một cha nên không có đường ghép chéo.
5. `meetings.attempt` đếm từ **1** (thiết kế cũ ghi DEFAULT 0) để khớp `jobId …a1` không cần cộng thêm.
6. **Rủi ro checksum của SDK v3 không xảy ra với RustFS 1.0.1** — nhưng phải _chạy thử_ mới biết. Multipart bằng stream (`Readable` sinh dần 64 KiB, không Buffer sẵn) + `ContentLength` chạy với cấu hình mặc định. Mã lỗi thật đã ghi nhận: phần không-phải-cuối < 5 MiB → `EntityTooSmall` **lúc complete** (không phải lúc upload phần); upload phần sau khi abort → `NoSuchUpload`. `HeadObject` lỗi không có body nên chỉ còn mã HTTP 404 (`NotFound`) — `isS3Error` xét cả `name` lẫn mã HTTP.
7. **RustFS mở cổng trước khi sẵn sàng** → global setup thử `CreateBucket` tới 30 lần, mỗi lần cách 500 ms, thay vì tin vào "cổng đã mở". `S3Client.destroy()` lúc module dừng: SDK giữ socket keep-alive, không đóng thì tiến trình dừng chậm / test treo.
8. **Chạy app thật với `.env` của máy dev phát hiện hai bẫy ngoài code:** (a) `.env` đặt `PORT=5000` mà trên macOS cổng 5000 bị **ControlCenter (AirPlay Receiver)** giữ → `EADDRINUSE`; (b) app đặt `process.title = 'meetnote-api'` nên `pkill -f dist/main.js` **không bắt được** tiến trình — phải tắt theo PID / theo tên `meetnote-api`.
