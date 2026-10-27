# 06 — Luồng xử lý chi tiết

## 1. Upload → transcript → tóm tắt

### 1.1 Upload chunked, resume được

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as api
  participant DB as Postgres
  participant S3 as RustFS/S3
  participant Q as Redis (BullMQ)

  C->>A: POST /uploads {filename, sizeBytes, sha256, title, recordedAt} (Idempotency-Key)
  A->>DB: giữ chỗ key (INSERT … ON CONFLICT DO UPDATE … WHERE hết hạn / quá lease)
  alt key đã xong, cùng nội dung
    A-->>C: 201 upload cũ (Idempotent-Replayed: true)
  end
  A->>A: validate (≤ 2GB, mime cho phép)
  A->>S3: CreateMultipartUpload
  A->>DB: INSERT uploads (status=initiated, expires_at=+24h)
  A->>DB: lưu response vào idempotency_keys (completed)
  A-->>C: {uploadId, chunkSize: 8MB, totalParts}

  loop mỗi part (có thể song song 3–4)
    C->>A: PUT /uploads/:id/parts/:n (octet-stream)
    A->>S3: UploadPart (stream thẳng req → S3, không buffer cả file)
    A->>DB: INSERT upload_parts ON CONFLICT DO UPDATE
    A-->>C: 200 {partNumber, etag}
  end

  Note over C,A: Mất mạng → GET /uploads/:id → nhận danh sách part đã có → gửi tiếp phần thiếu

  C->>A: POST /uploads/:id/complete
  A->>DB: BEGIN; SELECT uploads FOR UPDATE
  alt đã completed
    A-->>C: 200 meeting cũ (idempotent)
  else
    A->>S3: CompleteMultipartUpload(parts)
    A->>DB: INSERT meetings (status=queued); UPDATE uploads (completed); COMMIT
    A->>Q: add('meeting.preprocess', {meetingId}, {jobId: meeting.preprocess.{id}.a1})
    A-->>C: 201 meeting
  end
```

Bẫy & cách xử lý:

- **Không đọc cả part vào RAM**: 8 MB × 100 request song song là 800 MB. Pipe stream request vào `UploadPart` với `ContentLength`. Phải giới hạn body size theo route.
- `Content-Length` của part ≠ `chunkSize` (trừ part cuối) thì trả 400 ngay.
- **Checksum:** `sha256` toàn file do client gửi lúc init. Worker kiểm tra lại sau khi tải về. Từng part có thể gửi `Content-MD5`/`x-amz-checksum-sha256` để S3 tự kiểm tra.
- **S3 xong mà DB lỗi (M5 B5).** S3 `CompleteMultipartUpload` thành công rồi transaction rollback → DB vẫn `initiated` nhưng multipart đã ghép xong. Gọi lại complete: **RustFS** cho complete lại và trả thành công; **AWS S3** có thể trả `NoSuchUpload`. Service xử lý cả hai: gặp `NoSuchUpload` thì `HEAD` object — có và đúng `size_bytes` → coi như S3 xong, đi tiếp phần ghi DB; không có → multipart đã bị huỷ → 409. Không có bước này thì upload kẹt mãi trên server kiểu AWS.
- **Enqueue sau COMMIT.** Nếu enqueue trước, worker có thể chạy khi meeting chưa tồn tại trong DB. Nếu commit xong mà enqueue lỗi: complete vẫn trả meeting (không ném); gọi lại complete enqueue lại (jobId trùng → BullMQ bỏ qua nếu đã có); từ M6 job quét meeting `queued` quá 5 phút để enqueue lại. Đây là bản "outbox nghèo".
- `jobId = meeting.preprocess.{meetingId}.a{attempt}`: BullMQ bỏ qua job trùng ID, nên enqueue lại là an toàn. ID phải chứa **tên bước**, vì các bước dùng chung queue mà trùng ID thì bước sau bị bỏ qua. ID cũng phải chứa **lần chạy** (`attempt`), vì job cũ còn giữ trong tập failed/completed thì `POST /retry` sẽ bị bỏ qua. BullMQ **cấm dấu `:`** trong custom jobId (`Custom Id cannot contain :`).
- **Init lặp lại (M5 B6).** Init không tự idempotent: gọi lại là mở multipart mới. Client mất response (timeout, mất mạng) mà gửi lại không kèm key → hai upload, một cái bỏ dở tới khi hết hạn. Kèm `Idempotency-Key` → lần sau nhận lại đúng upload cũ. Complete thì KHÔNG cần key (tự idempotent theo trạng thái).
- **Upload bỏ dở (M5 B7):** job dọn dẹp đánh dấu `expired` theo lô (`FOR UPDATE SKIP LOCKED`, transaction ngắn), **commit rồi mới** gọi `AbortMultipartUpload` từng upload (không giữ khoá + connection lúc gọi mạng). Nếu không abort, S3 vẫn tính dung lượng cho các part mồ côi.
  - **Ân hạn 10 phút sau `expires_at`.** Abort multipart lúc còn part đang gửi thì part đó "có thể thành công hoặc không" (AWS khuyên abort lại). Part chỉ bắt đầu được trước `expires_at`, Node cắt request quá `requestTimeout` (5 phút) → sau 10 phút không còn part nào đang gửi.
  - **S3 lỗi / tiến trình chết giữa hai pha:** `storage_aborted_at` còn NULL → lượt thử lại (một lô mỗi lần chạy job) gom cả upload hết hạn lẫn upload huỷ thủ công bị lỗi S3.
  - **Huỷ thủ công** abort ngay, nên vẫn có thể còn part đang gửi dở bị S3 lưu lại. Lưới an toàn cuối khi lên production: lifecycle rule của bucket `AbortIncompleteMultipartUpload` (vd sau 2 ngày).

### 1.2 Pipeline xử lý (worker)

Dùng **BullMQ Flow** hoặc chuỗi job, mỗi bước một job riêng để retry độc lập:

```mermaid
sequenceDiagram
  autonumber
  participant Q as BullMQ
  participant W as worker
  participant DB as Postgres
  participant S3 as RustFS/S3
  participant WH as whisper.cpp
  participant L as LLM
  participant R as Redis (emitter)

  Q->>W: meeting.preprocess {meetingId}
  W->>DB: CLAIM: UPDATE status=preprocessing, token, lease WHERE attempt AND status IN (queued, preprocessing) AND lease trống/hết hạn
  W->>S3: GetObject (stream ra file tạm)
  W->>W: ffprobe (duration ≤ 4h) + ffmpeg → wav 16kHz mono
  W->>S3: PutObject audio chuẩn hoá
  W->>Q: add meeting.transcribe

  Q->>W: meeting.transcribe (queue "transcription", concurrency 1)
  W->>DB: CLAIM: UPDATE token, lease WHERE attempt AND status=transcribing AND lease trống/hết hạn
  W->>WH: spawn whisper-cli -m model -f audio.wav -oj -pp
  loop stdout tiến độ
    W->>R: emit meeting.progress {stage: transcribing, percent}
  end
  WH-->>W: JSON segments [{from, to, text}]
  W->>DB: BEGIN; DELETE segments; INSERT segments (batch); UPDATE status=summarizing; COMMIT
  W->>Q: add meeting.summarize

  Q->>W: meeting.summarize
  W->>L: map: tóm tắt từng đoạn ~N token → reduce: tóm tắt tổng (prompt kèm NGÀY HỌP giờ VN + thứ; model quy hạn ra `dueDate`, server validate lại — M12)
  W->>DB: BEGIN; UPDATE status=completed (kiểm token); UPSERT meeting_summaries; INSERT action_items ON CONFLICT DO NOTHING; INSERT notification; COMMIT
  W->>R: emit meeting.status {completed}
  W->>Q: add notification.fanout {type: meeting.completed}
```

Retry & lỗi:

| Bước       | attempts | backoff         | Lỗi không retry (fail ngay)      |
| ---------- | -------- | --------------- | -------------------------------- |
| preprocess | 3        | exponential 10s | file hỏng, quá 4h, sai định dạng |
| transcribe | 2        | exponential 60s | model không tồn tại              |
| summarize  | 5        | exponential 30s | 4xx từ LLM (trừ 429)             |

- Lỗi không retry: ném `UnrecoverableError` của BullMQ.
- Hết attempts: event `failed` đưa meeting vào `status=failed, failure_code`, emit `meeting.status`, gửi thông báo cho chủ meeting.
- **Idempotent mọi bước — LEASE + FENCING TOKEN (M6 B4).** Job có thể chạy 2 lần (worker chết giữa chừng, job "stalled" bị chạy lại) và mỗi bước có retry. `status` là CHẶNG hiện tại (đang chờ hoặc đang chạy): preprocess xong → `transcribing`, transcribe xong → `summarizing`, summarize xong → `completed`.
- **Action items (M12 B3):** việc cần làm được trích TRONG transaction của bước tóm tắt, sau khi `completeSummarize` xác nhận còn giữ lease — tóm tắt, `completed`, việc và thông báo cùng sống / cùng chết. Người phụ trách model nêu ("anh Bình") được map sang thành viên org bằng hàm thuần `matchAssignee`: chỉ gán khi **đúng một** người khớp (cả tên, hoặc tên gọi = từ cuối của họ tên; bỏ xưng hô), mơ hồ / không khớp thì để trống và giữ chữ gốc — **không đoán**. Chèn bằng `ON CONFLICT (meeting_id, source_index) WHERE origin = 'ai' DO NOTHING`: bước tóm tắt chạy lại không sinh trùng và không đè việc người đã sửa. Hệ quả: chạy lại tóm tắt **không** thay danh sách việc (muốn thế cần mốc "trích lại"). Tải danh sách thành viên chỉ khi có việc nêu tên người.
  - **Nhận việc** (`claim`): MỘT câu UPDATE đặt `stage_token` mới + `stage_lease_until`, CHỈ khi đúng `attempt`, chưa xoá, đúng chặng, và lease trống hoặc đã hết hạn. Hai worker cùng nhận → một bên 0 dòng → bỏ qua.
  - **Lỗi** (tạm hay vĩnh viễn) → nhả lease ngay để retry nhận lại được (bản đầu chỉ "UPDATE WHERE status = <chặng trước>": retry của BullMQ thấy status đã đổi → bỏ qua → meeting kẹt mãi).
  - **Ghi kết quả**: một transaction ngắn, chuyển chặng TRƯỚC với điều kiện `stage_token = token của mình` (fencing) — lease hết hạn và worker khác đã nhận thì 0 dòng → không ghi; rồi ghi kết quả kiểu "xoá rồi ghi" / upsert. Enqueue bước kế SAU commit.
- **Quét meeting kẹt (M6 B8, mỗi 5 phút).** Chuỗi job có thể đứt: api commit `queued` rồi Redis lỗi lúc enqueue; worker chết cứng (SIGKILL) giữa bước → BullMQ chạy lại job "stalled" nhưng lease còn → job bỏ qua rồi `completed`, lease hết thì không còn job nào. Quét lấy meeting chưa xong, `updated_at` cũ hơn 10 phút, **không ai giữ lease** (đang chạy thật thì có lease, dù whisper chạy hàng giờ), keyset `(updated_at, id)`. Với mỗi meeting: job THƯỜNG của bước (`…a<attempt>`) còn sống (`waiting` / `delayed` / `active`…) → để yên (đang xếp hàng sau bản ghi dài ở queue `transcription`, không phải kẹt); không thì enqueue lại với jobId **riêng** `…a<attempt>.r<updated_at µs>` — dùng lại `…a<attempt>` sẽ bị BullMQ nuốt vì job cũ đã completed còn được giữ. Cùng trạng thái kẹt → cùng id → quét lặp không nhân đôi. Quét chỉ bảo đảm tiến triển; đúng đắn vẫn ở `claim`.
- **Graceful shutdown (M6 B5, B8).** `beforeApplicationShutdown` huỷ job đang chạy (AbortSignal tới whisper / SDK, nhả lease) rồi đưa về `delayed` (`DelayedError`, không tốn lượt) — chạy TRƯỚC `onApplicationShutdown` nơi `worker.close()` chờ job. Từ lúc đó job nào worker kịp lấy thêm (slot vừa trống) cũng trả về `delayed` ngay, không chạy — nếu không, `close()` chờ job mới đó (bài học 16 của plan M6).
- Whisper trong Docker trên macOS chỉ chạy CPU, rất chậm. Có thể chạy worker native trên host (`pnpm start:worker`) để dùng Metal.

## 2. Tạo báo cáo tuần

```mermaid
sequenceDiagram
  autonumber
  participant S as BullMQ Job Scheduler
  participant W as worker
  participant DB as Postgres
  participant Q as BullMQ
  participant L as LLM

  Note over S: upsertJobScheduler('weekly-report-tick',<br/>{pattern: '0 8 * * 1', tz: 'Asia/Ho_Chi_Minh'})
  S->>W: weekly-report.tick {firedAt}
  W->>W: weekStart = thứ 2 tuần trước (tính theo giờ VN từ firedAt)
  loop từng lô kênh (weekly_report_enabled, chưa xoá/lưu trữ), keyset pagination
    W->>DB: INSERT weekly_reports (channel, weekStart, pending) ON CONFLICT DO NOTHING RETURNING id
    W->>Q: add weekly-report.generate {reportId} jobId=weekly-report.generate.{id}.v1
  end

  Q->>W: weekly-report.generate {reportId}
  W->>DB: UPDATE weekly_reports SET status=generating WHERE id AND status IN (pending, failed)
  W->>DB: đếm meeting completed share vào kênh, recorded_at ∈ [weekStart, weekStart+7d) giờ VN
  alt < 2 meeting
    W->>DB: UPDATE status=skipped
  else ≥ 2 meeting
    W->>DB: đọc summaries của các meeting
    W->>L: tổng hợp báo cáo
    W->>DB: BEGIN; INSERT versions (version = n); UPDATE reports SET status=completed, current_version=n; COMMIT
    W->>Q: notification.fanout (thành viên kênh trừ Guest, dedupe_key=report-ready.{id}.v{n}) — CHỈ bản theo lịch
  end
```

Điểm cần chú ý:

- **Múi giờ.** Cron với `tz` để BullMQ tính đúng 08:00 giờ VN. Khoảng tuần trong SQL: `recorded_at >= ($weekStart::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`. Không dùng `date_trunc('week', now())`, vì nó chạy theo timezone của session DB.
- **Tick idempotent (M9 B5).** Hai pha: (1) `INSERT … SELECT` từ `channels` theo lô keyset (`ON CONFLICT (channel_id, week_start) DO NOTHING`), (2) xếp job `generate` cho **MỌI dòng `pending` của tuần** (không chỉ dòng vừa chèn: tick trước có thể đã chèn rồi chết trước khi enqueue) với `jobId = weekly-report.generate.{id}.g{generation}` cố định nên trùng thì BullMQ bỏ qua. Tick chỉ "fan-out", không gọi LLM. Một job enqueue lỗi không chặn kênh khác; cuối tick ném lỗi để BullMQ chạy lại tick (idempotent → chỉ làm phần thiếu). `weekStart` suy từ MỐC LỊCH BẮN (`job.timestamp + job.delay`), không từ lúc xử lý.
- **Retry AI:** `attempts: 5, backoff: exponential` từ 30 s. Lỗi vĩnh viễn (LLM từ chối / 4xx) → `failed` ngay, không retry. Hết lượt → `status=failed`, `last_error`; `current_version` giữ nguyên (người xem vẫn thấy bản cũ). Không tính vào quota tạo lại. **Máy trạng thái = lease + fencing token** (`generation_token`, `lease_until`, như meeting M6): `claim` nhận `pending`, hoặc `generating` có lease trống / hết hạn, và đúng `generation` (= `regenerate_count` lúc enqueue); lỗi tạm thì nhả lease nên retry nhận lại ngay. Không dùng `UPDATE … WHERE status IN (pending, failed)` như bản thiết kế đầu: retry thấy `generating` do chính lần thử trước để lại → kẹt mãi.
- **Tạo lại thủ công** (`POST …/regenerate`):
  1. `BEGIN; SELECT … FOR UPDATE`.
  2. `status = generating` thì 409 `REPORT_IN_PROGRESS`. `regenerate_count >= 3` thì 409 `REPORT_REGENERATE_LIMIT`.
  3. `count += 1; status = pending`.
  4. COMMIT, rồi enqueue `jobId=weekly-report.generate.{id}.v{count+1}`.

  Tạo lại tính lại danh sách meeting từ đầu, nên meeting xong muộn cũng được đưa vào.

- **Lỡ lịch.** Redis down đúng lúc 08:00 thì tick bị lỡ. Chạy bù bằng `pnpm report:backfill --week 2026-10-05` (script xếp một job `weekly-report.tick` có `weekStart` tường minh; không có endpoint admin vì dự án chưa có khái niệm quản trị hệ thống). Idempotent nên chạy thừa an toàn; script thất bại nhanh (≈ 2 s) với thông báo rõ nếu Redis không chạy. Báo cáo `pending` mất job / `generating` hết lease được job quét 5 phút xếp lại (B7).
- **Thông báo (M9 B7, Q7).** Bản THEO LỊCH: sau commit xếp MỘT job `notification.fanout` (`report-ready.{id}.v{n}`) → worker gửi theo lô cho thành viên kênh trừ Khách, `dedupe_key` chặn trùng khi chạy lại. Bản TẠO LẠI thủ công: chỉ người bấm (họ đang chờ; cả kênh nhận thêm tối đa 3 thông báo mỗi tuần là ồn), ghi TRONG transaction của phiên bản — rollback thì không có thông báo "ma" — và chỉ khi người đó CÒN là thành viên tổ chức (`FOR SHARE` dòng thành viên): thông báo có composite FK tới thành viên, người đã rời mà vẫn `INSERT` thì lỗi `23503` rollback cả phiên bản và báo cáo không bao giờ xong. `skipped` / job trùng / mất lease không thông báo. Enqueue fan-out lỗi chỉ log (phiên bản đã commit, báo cáo vẫn đọc được).
- **Quét báo cáo kẹt (M9 B7, mỗi 5 phút).** Báo cáo `pending` / `generating` lâu không đổi (> 10 phút) và không ai giữ lease: nếu job thường `…g{generation}` còn sống (chờ / chờ retry / đang chạy) thì để yên, không thì xếp lại với jobId riêng `…g{generation}.r{updated_at µs}` (cùng bài học M6 B8: job cũ đã completed còn giữ sẽ nuốt `add()`). Chỉ bảo đảm tiến triển — đúng đắn vẫn ở `claim` (lease + `generation`).

## 3. Chuyển quyền chủ kênh

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (CO hoặc OrgAdm)
  participant A as api
  participant DB as Postgres

  C->>A: POST /channels/:channelId/ownership-transfer {newOwnerId}
  A->>A: Guards: JWT → OrgMember → ChannelAccess → @RequireChannelPermission('channel.ownership.transfer')
  A->>DB: BEGIN
  A->>DB: SELECT role FROM organization_members WHERE org_id=$1 AND user_id IN ($actor,$new)<br/>ORDER BY user_id FOR SHARE
  Note right of DB: Bậc 1 — người nhận không bị gỡ khỏi org giữa chừng;<br/>vai trò OrgAdm của người gọi giữ nguyên
  A->>DB: SELECT * FROM channels WHERE id=$2 AND deleted_at IS NULL FOR UPDATE
  Note right of DB: Bậc 2 — mutex của kênh
  A->>A: Kiểm tra lại quyền với vai trò VỪA KHOÁ (kênh chưa lưu trữ; actor vẫn là CO hoặc OrgAdm)
  A->>DB: SELECT user_id, role FROM channel_members WHERE channel_id=$2<br/>AND (role='owner' OR user_id=$new) ORDER BY user_id FOR UPDATE
  Note right of DB: Bậc 3 — chủ hiện tại + người nhận
  A->>A: Người nhận là thành viên kênh (không → 404), không phải Khách / chủ hiện tại (→ 409)
  A->>DB: UPDATE channel_members SET role='admin' WHERE user_id=$old  -- hạ trước
  A->>DB: UPDATE channel_members SET role='owner' WHERE user_id=$new  -- nâng sau
  A->>DB: INSERT audit_logs (channel.ownership.transferred, before/after)
  A->>DB: COMMIT
  A-->>C: 200 {channelId, ownerId: new}
```

Vì sao làm như vậy:

- **Theo đúng thứ tự khoá chung** (`03-database.md` §7): `organization_members` → `channels` → `channel_members`. Gỡ X khỏi org khoá dòng org của X rồi cascade xoá dòng `channel_members` của X. Nếu chuyển chủ kênh khoá kênh + `channel_members` TRƯỚC rồi mới khoá dòng org của X, hai bên chờ nhau vòng tròn → Postgres giết một bên với `40P01`. Race test `channel-ownership-race.int-spec.ts` ép đúng thứ tự xen kẽ này; đột biến đảo thứ tự → `pg:40P01` sau ~1 giây (`deadlock_timeout`).
- **Khoá dòng `channels` làm mutex.** Chuyển chủ cho X song song với X rời kênh / bị gỡ khỏi kênh thì chạy tuần tự: không bao giờ "chủ là người không còn trong kênh".
- **`ORDER BY user_id` khi khoá nhiều dòng** ở cùng một bậc: thứ tự cố định nên không deadlock giữa hai thao tác cùng loại.
- **Kiểm tra lại sau khi khoá.** Dữ liệu guard đọc lúc đầu có thể đã cũ (actor vừa bị hạ quyền, vừa chuyển chủ cho người khác ở request song song).
- **Hạ trước nâng sau.** Partial unique index `one owner per channel` không deferrable.
- **Chủ cũ thành QTV kênh**, không bị gỡ khỏi kênh. Ai muốn rời thì làm bước riêng.
- **Test:** 2 transfer song song tới 2 người khác nhau → đúng 1 thành công (lần sau thấy mình không còn là chủ → 403), kênh có đúng 1 chủ.
- Thông báo cho chủ mới / chủ cũ (gửi sau commit) đến ở M10.
