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

  C->>A: POST /uploads {filename, sizeBytes, sha256, title, recordedAt}
  A->>A: validate (≤ 2GB, mime cho phép)
  A->>S3: CreateMultipartUpload
  A->>DB: INSERT uploads (status=initiated, expires_at=+24h)
  A-->>C: {uploadId, chunkSize: 8MB, totalParts}

  loop mỗi part (có thể song song 3–4)
    C->>A: PUT /uploads/:id/parts/:n (octet-stream)
    A->>S3: UploadPart (stream thẳng req → S3, không buffer cả file)
    A->>DB: INSERT upload_parts ON CONFLICT DO UPDATE
    A-->>C: 200 {partNumber, etag}
  end

  Note over C,A: Mất mạng → GET /uploads/:id → nhận danh sách part đã có → gửi tiếp phần thiếu

  C->>A: POST /uploads/:id/complete (Idempotency-Key)
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
- Upload bỏ dở: job dọn dẹp (`FOR UPDATE SKIP LOCKED`) gọi `AbortMultipartUpload` và set `expired`. Nếu không abort, S3 vẫn tính dung lượng cho các part mồ côi.

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
  W->>DB: UPDATE meetings SET status=preprocessing WHERE status IN (queued, failed)
  W->>S3: GetObject (stream ra file tạm)
  W->>W: ffprobe (duration ≤ 4h) + ffmpeg → wav 16kHz mono
  W->>S3: PutObject audio chuẩn hoá
  W->>Q: add meeting.transcribe

  Q->>W: meeting.transcribe (queue "transcription", concurrency 1)
  W->>DB: UPDATE status=transcribing WHERE status=preprocessing
  W->>WH: spawn whisper-cli -m model -f audio.wav -oj -pp
  loop stdout tiến độ
    W->>R: emit meeting.progress {stage: transcribing, percent}
  end
  WH-->>W: JSON segments [{from, to, text}]
  W->>DB: BEGIN; DELETE segments; INSERT segments (batch); UPDATE status=summarizing; COMMIT
  W->>Q: add meeting.summarize

  Q->>W: meeting.summarize
  W->>L: map: tóm tắt từng đoạn ~N token → reduce: tóm tắt tổng
  W->>DB: UPSERT meeting_summaries; UPDATE status=completed
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
- **Idempotent mọi bước.** Job có thể chạy 2 lần (worker chết giữa chừng, job "stalled" bị chạy lại). Mỗi bước bắt đầu bằng UPDATE có điều kiện, ghi kết quả theo kiểu "xoá rồi ghi" hoặc upsert.
- **Graceful shutdown.** Worker nhận SIGTERM thì `worker.close()`, chờ job hiện tại xong. Riêng whisper chạy lâu thì kill child process và để job retry.
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
    W->>Q: notification.fanout (thành viên kênh trừ Guest, dedupe_key=report:{id}:v{n})
  end
```

Điểm cần chú ý:

- **Múi giờ.** Cron với `tz` để BullMQ tính đúng 08:00 giờ VN. Khoảng tuần trong SQL: `recorded_at >= ($weekStart::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`. Không dùng `date_trunc('week', now())`, vì nó chạy theo timezone của session DB.
- **Tick idempotent.** Tick chạy 2 lần thì `ON CONFLICT DO NOTHING` + `jobId` cố định nên không tạo trùng. Tick chỉ "fan-out" ra job nhỏ, không gọi LLM trực tiếp. Một kênh lỗi không làm hỏng các kênh khác.
- **Retry AI:** `attempts: 5, backoff: exponential`. Hết lượt thì `status=failed`, `last_error`. Không tính vào quota tạo lại.
- **Tạo lại thủ công** (`POST …/regenerate`):
  1. `BEGIN; SELECT … FOR UPDATE`.
  2. `status = generating` thì 409 `REPORT_IN_PROGRESS`. `regenerate_count >= 3` thì 409 `REPORT_REGENERATE_LIMIT`.
  3. `count += 1; status = pending`.
  4. COMMIT, rồi enqueue `jobId=weekly-report.generate.{id}.v{count+1}`.

  Tạo lại tính lại danh sách meeting từ đầu, nên meeting xong muộn cũng được đưa vào.

- **Lỡ lịch.** Redis down đúng lúc 08:00 thì tick bị lỡ. Thêm endpoint/CLI admin `report:backfill --week 2026-10-05` để chạy bù. Vì idempotent nên chạy thừa cũng an toàn.

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
