# M6 — Pipeline xử lý

- **Trạng thái:** **Hoãn** (người dùng 2026-10-21: làm sau). Plan nháp, chưa duyệt Q1–Q6. Phần chia sẻ / quyền xem tách sang [M6b](M6b-meeting-sharing.md)
- **Nhánh:** `m6-pipeline`
- **Lưu ý từ M10 B5:** worker đã có `DefaultQueueProcessor` (`src/worker/default-queue.processor.ts`) cho queue `default`. Trong lúc M6 hoãn, nó **cất** `meeting.preprocess` về `delayed` 1 giờ (`moveToDelayed` + `DelayedError`, không tính lần thử) thay vì làm job `failed`. Làm M6 thì thay nhánh đó bằng xử lý thật — job đang cất sẽ chạy ở lượt kế tiếp.
- **Tài liệu thiết kế liên quan:** [01-overview D5, D6](../design/01-overview.md), [02-architecture §1, §4](../design/02-architecture.md), [03-database §4 `transcript_segments`, `meeting_summaries`](../design/03-database.md), [05-api Meetings](../design/05-api.md), [06-flows §1.2](../design/06-flows.md), [08-testing §5](../design/08-testing.md), [10-roadmap M6](../design/10-roadmap.md)

## Mục tiêu

Cuối mốc, meeting `queued` (do M5 tạo) **tự đi hết pipeline** trong tiến trình worker:

- **preprocess:** tải file gốc từ S3, kiểm `sha256` (M5 hoãn sang đây), `ffprobe` (có audio, ≤ 4 giờ), `ffmpeg` → WAV 16 kHz mono, đẩy audio chuẩn hoá lên S3;
- **transcribe:** `whisper.cpp` (child process) → các đoạn transcript có timestamp;
- **summarize:** LLM tóm tắt (map-reduce khi transcript dài) → `{ overview, keyPoints, decisions, actionItems }`;
- trạng thái `queued → preprocessing → transcribing → summarizing → completed`, mỗi bước **retry độc lập** theo backoff; lỗi vĩnh viễn fail ngay; hết lượt → `failed` kèm `failure_code`;
- chủ meeting xem trạng thái, transcript, tóm tắt qua API, và **chạy lại** khi `failed`;
- worker **lên lịch** các job dọn đã viết logic ở M4 / M5, và **quét meeting kẹt** (enqueue sau commit bị lỗi, worker chết giữa chừng);
- **graceful shutdown:** dừng worker không làm mất job, không để process con mồ côi.

Tiêu chí thật (roadmap): **upload một file ghi âm tiếng Việt → transcript + tóm tắt tự xuất hiện**, chạy tay với whisper thật.

## Ngoài phạm vi

- Chia sẻ meeting vào kênh, quyền xem theo kênh (04 §3), danh sách / sửa / xoá meeting → **M6b** nếu Q1 được duyệt.
- Tiến độ realtime qua Socket.IO (M7). M6 chỉ `job.updateProgress()`, API trả trạng thái, không trả %.
- Thông báo khi meeting xong / lỗi (M10). M6 chỉ log.
- Tìm full-text, xuất SRT/VTT (M8). Cột `search` (tsvector) vẫn tạo ở B1 để M8 không phải backfill.
- Phân biệt người nói (diarization), GPU trong Docker.

## Quyết định cần duyệt

| #   | Câu hỏi                                     | Đề xuất ★                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Phương án khác                                                                                                                                                             |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | M6 có tách đôi không?                       | ★ **Tách.** M6 = Pipeline (plan này). **M6b — Chia sẻ & quyền xem meeting**: share / gỡ share, điều kiện xem dùng chung (04 §3), `GET /meetings`, `GET /channels/:id/meetings`, sửa / xoá meeting, purge kênh gỡ share. Hai chủ đề khác hẳn nhau (child process + queue ↔ phân quyền bằng SQL), mỗi chủ đề ~8 bước. Sửa roadmap khi duyệt                                                                                                                                                                                                                                                                                 | Giữ một mốc (~15 bước, một PR rất lớn, khó review)                                                                                                                         |
| Q2  | LLM cho tóm tắt (01-overview: "chưa chốt")? | ★ **Claude API** qua `@anthropic-ai/sdk`: structured output bằng tool use có JSON schema, model đặt bằng env `LLM_MODEL` (mặc định `claude-opus-5-5`, đổi sang `claude-haiku-5-5` nếu muốn rẻ). `LLM_PROVIDER=fake\|anthropic`, **mặc định `fake`** → dev / test / CI không cần key. **Cần bạn xác nhận việc gửi transcript ra API bên ngoài là chấp nhận được** (dữ liệu là bản ghi họp của bạn)                                                                                                                                                                                                                         | **Ollama chạy local**: dữ liệu không rời máy, nhưng phải cài + tải model vài GB, tiếng Việt kém hơn, chậm trên M1. **Chỉ Fake ở M6**, chọn provider sau                    |
| Q3  | `ffmpeg` / `whisper.cpp` chạy ở đâu?        | ★ **Dev: cài trên máy bằng Homebrew** (`ffmpeg 9.0.2`, `whisper.cpp 1.9.5`; Metal trên M1 → nhanh), worker chạy native `pnpm start:worker`. **Docker:** `apk add ffmpeg`, whisper.cpp build từ source (pin tag) trong stage riêng, **model mount từ volume** (không nhét 0,5–1,6 GB vào image; trong Docker trên Mac chỉ có CPU). **Test:** ffmpeg **thật** trong integration test (audio sinh bằng `ffmpeg -f lavfi`), CI cài ffmpeg; whisper thật **không** chạy trên CI — adapter được test bằng một **"whisper giả"** (script in ra đúng định dạng stdout / JSON, có chế độ lỗi / treo); `pnpm test:whisper` chạy tay | Chỉ chạy trong Docker (CPU, chậm hơn nhiều lần). Fake luôn cả ffmpeg trong test (không bắt được lỗi tham số ffmpeg thật)                                                   |
| Q4  | Nối các bước thế nào?                       | ★ **Chuỗi job**: bước xong (commit) thì enqueue bước sau, `jobId = meeting.<bước>.<id>.a<attempt>` — đúng mẫu "enqueue sau commit" của M5. Bước nào lỗi chỉ retry bước đó                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **BullMQ Flow** (cây parent / children): children chạy TRƯỚC parent, hợp với "gom kết quả" hơn là chuỗi tuần tự; muốn retry thủ công một bước giữa chừng phải dựng lại cây |
| Q5  | M6 mở API đọc kết quả tới đâu?              | ★ `GET /meetings/:id` (thêm `durationMs`, `language`, `failureCode`), **`GET /meetings/:id/transcript`** (cursor theo `seq`), **`GET /meetings/:id/summary`**, **`POST /meetings/:id/retry`** — chỉ **chủ meeting** (M6b mở rộng theo 04 §3). Tìm kiếm + xuất file vẫn ở M8                                                                                                                                                                                                                                                                                                                                               | Chỉ trạng thái, transcript / summary để M8 → không kiểm được "transcript + tóm tắt tự xuất hiện" qua API                                                                   |
| Q6  | Chặn job cũ / trùng thế nào?                | ★ Payload `{ meetingId, attempt, requestId }`. Mỗi bước mở đầu bằng **UPDATE có điều kiện** `WHERE id AND attempt = $attempt AND status = <trạng thái trước> AND deleted_at IS NULL RETURNING` — 0 dòng = job cũ (lần chạy trước), trùng, hoặc meeting đã xoá → log rồi bỏ qua. `attempt` đóng vai trò fencing token như B6 của M5                                                                                                                                                                                                                                                                                        | Payload chỉ `meetingId`, lấy `attempt` bằng cách tách chuỗi `jobId` (dễ vỡ khi đổi định dạng id)                                                                           |

Quyết định nhỏ đã tự chốt, sửa được nếu bạn muốn:

- **Hai queue theo đặc tính tải:** `default` (preprocess, summarize, dọn dẹp, quét; concurrency 4) và `transcription` (transcribe; **concurrency 1** vì whisper chiếm hết CPU / GPU). Env `WORKER_QUEUES` chọn queue mà một worker nghe (mặc định cả hai).
- **Retry** theo 06 §1.2: preprocess 3 × exp 10 s, transcribe 2 × exp 60 s, summarize 5 × exp 30 s. Lỗi vĩnh viễn → `UnrecoverableError`.
- **`failure_code`** (lưu trên meeting, không phải mã lỗi HTTP): `SOURCE_CHECKSUM_MISMATCH`, `MEDIA_UNREADABLE`, `MEDIA_NO_AUDIO`, `MEDIA_TOO_LONG`, `TRANSCRIBE_FAILED`, `SUMMARIZE_FAILED`. `failure_message` là câu ngắn cho người dùng; stderr thô chỉ vào log.
- **File tạm:** `mkdtemp` riêng cho mỗi job, xoá trong `finally`. Tải S3 bằng stream thẳng xuống file (không buffer), tính `sha256` **trong cùng lượt tải**.
- **Process con:** `spawn` với mảng tham số, không qua shell; có timeout (ffmpeg 30 phút; whisper theo độ dài audio × hệ số trong env); quá hạn / shutdown → kill.
- **Tóm tắt:** transcript dài hơn ngưỡng (theo số ký tự ≈ token) thì chia đoạn → tóm tắt từng đoạn (map) → gộp (reduce). Lưu `model`, `prompt_version`, số token. Kết quả LLM được **validate lại** ở server; sai schema = lỗi tạm (retry).
- **Lịch chạy** (BullMQ Job Scheduler, upsert khi worker khởi động → nhiều worker vẫn một lịch): dọn upload + thử abort lại + dọn `idempotency_keys` mỗi 10 phút; purge kênh 03:00 hằng ngày (`Asia/Ho_Chi_Minh`); quét meeting kẹt mỗi 5 phút.
- **Không ghi audit** cho pipeline (thao tác của hệ thống, không phải quản trị).
- `GET /summary` khi meeting chưa `completed` → 409 `MEETING_NOT_COMPLETED`; `POST /retry` khi không `failed` → 409 `MEETING_NOT_FAILED`.

## Thay đổi thiết kế

### Bảng (sửa `03-database.md` §4)

| Bảng                  | Cột chính                                                                                                         | Ràng buộc / index                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript_segments` | như 03 §4: id bigint identity, meeting_id, seq, start_ms, end_ms, speaker NULL, text, `search` tsvector generated | `UNIQUE (meeting_id, seq)`, CHECK `end_ms >= start_ms`, FK meeting ON DELETE CASCADE, GIN `(search)` với config `meetnote_vi`. Một bảng cha → không cần `org_id` (như `upload_parts`) |
| `meeting_summaries`   | như 03 §4: meeting_id PK, content jsonb, model, prompt_version, input_tokens, output_tokens, created_at           | FK meeting ON DELETE CASCADE; ghi bằng upsert                                                                                                                                         |
| `meetings`            | (đã có từ M5)                                                                                                     | thêm index quét kẹt `(updated_at) WHERE status IN ('queued','preprocessing','transcribing','summarizing') AND deleted_at IS NULL`                                                     |

### API (sửa `05-api.md` Meetings), prefix `/v1/orgs/:orgId`

| Method | Path                              | Ai gọi (M6) | Ghi chú                                                                                                |
| ------ | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/meetings/:meetingId`            | Chủ meeting | Thêm `durationMs`, `language`, `failureCode`, `failureMessage`, `attempt`                              |
| GET    | `/meetings/:meetingId/transcript` | Chủ meeting | Đoạn theo `seq`, cursor; meeting chưa có transcript → mảng rỗng                                        |
| GET    | `/meetings/:meetingId/summary`    | Chủ meeting | Chưa `completed` → 409 `MEETING_NOT_COMPLETED`                                                         |
| POST   | `/meetings/:meetingId/retry`      | Chủ meeting | Chỉ khi `failed` (khác → 409 `MEETING_NOT_FAILED`): `attempt + 1`, `queued`, enqueue `a<n>` sau commit |

### Biến môi trường mới

`WORKER_QUEUES`, `FFMPEG_PATH`, `FFPROBE_PATH`, `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE` (mặc định `auto`), `WHISPER_TIMEOUT_FACTOR`, `LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY` (chỉ bắt buộc khi `LLM_PROVIDER=anthropic`). Thêm vào `.env.example`, `env.validation.ts`, `compose.yaml`.

## Dependency mới

| Thứ                  | Phiên bản (tra 2026-10-19)                   | Ghi chú                                                                                                   |
| -------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk`  | tra lúc cài (B3) theo skill `add-dependency` | Chỉ khi Q2 = Claude API                                                                                   |
| `ffmpeg` / `ffprobe` | 9.0.2 (Homebrew); bản của Alpine trong image | Binary, gọi bằng `spawn` — không dùng thư viện bọc (`fluent-ffmpeg`…): tự gọi process con là nội dung học |
| `whisper.cpp`        | 1.9.5 (Homebrew); cùng tag khi build Docker  | `whisper-cli`; model `ggml-large-v3-turbo` (q5) cho chạy thật, `ggml-base` cho thử nhanh                  |

## Bố cục code dự kiến

- `src/infra/process/`: helper chạy process con dùng chung (timeout, `AbortSignal`, đọc stdout / stderr theo dòng, giới hạn stderr giữ lại).
- `src/infra/media/`: `MediaTools` (probe, chuyển WAV) + adapter ffmpeg.
- `src/infra/speech/`: `SpeechToText` + `WhisperCppSpeechToText` + `FakeSpeechToText` (02-architecture đã dự kiến).
- `src/infra/llm/`: `Summarizer` + `AnthropicSummarizer` + `FakeSummarizer`.
- `ObjectStorage`: thêm tải object xuống file (stream) và đẩy file lên.
- `src/modules/meetings/`: tách **`MeetingsCoreModule`** (repository + service + pipeline, không controller) dùng cho cả api và worker, `MeetingsModule` (controller) import Core. Processor nằm ở module **chỉ `WorkerModule` import** (không để api tiêu thụ job). Uploads / channels tách Core tương tự để worker chạy được job dọn.

## Các bước

Mỗi bước = 1 commit, chạy được và có test. Chỗ nào có thể chạy trùng / song song đều có test race + đột biến.

- [ ] **B1 — Schema + migration**
  - Việc: `transcript_segments` (cột `search` tsvector generated, `customType`), `meeting_summaries`, index quét kẹt trên `meetings`.
  - Test (integration): `UNIQUE (meeting_id, seq)`, CHECK thời gian; xoá meeting → cascade; `search` khớp không dấu ("ke hoach" ↔ "kế hoạch") với `meetnote_vi`; EXPLAIN truy vấn quét kẹt dùng partial index.
- [ ] **B2 — Process con + ffmpeg + tải / đẩy file S3**
  - Việc: cài ffmpeg (Homebrew, hỏi trước); helper process con; `MediaTools.probe` (thời lượng, có audio không) và `toWav16kMono`; `ObjectStorage` tải xuống file / đẩy file lên bằng stream.
  - Test (integration, **ffmpeg thật**, RustFS thật): audio sinh bằng `lavfi` → WAV đúng 16 kHz mono, đúng thời lượng; video không có audio → `MEDIA_NO_AUDIO`; file rác → `MEDIA_UNREADABLE`; quá timeout → process con bị kill, không còn process mồ côi; tên file chứa `$(…)` / `;` không bị shell thực thi; tải / đẩy file vài chục MB không buffer.
- [ ] **B3 — SpeechToText + Summarizer (adapter + Fake)**
  - Việc: adapter whisper.cpp (tham số, đọc `progress = N%`, parse JSON đoạn); adapter Claude (tool use + JSON schema, map-reduce, phân loại lỗi: 4xx trừ 429 → vĩnh viễn; 429 / 5xx / timeout → tạm); Fake cho cả hai (cấu hình được "lỗi N lần rồi thành công"). `pnpm test:whisper` chạy tay với audio tiếng Việt sinh bằng `say -v Linh`.
  - Test: adapter whisper với **whisper giả** (đúng định dạng, lỗi, treo → bị kill); adapter LLM với **HTTP stub server** (SDK đặt `baseURL`) — schema đúng / sai, 400 vs 429 vs 500, transcript dài → nhiều lượt map + 1 lượt reduce. Không gọi API thật trên CI.
- [ ] **B4 — Pipeline service (chưa có BullMQ)**
  - Việc: `preprocess` / `transcribe` / `summarize` theo Q6: UPDATE có điều kiện → việc chạy lâu NGOÀI transaction → ghi kết quả kiểu thay thế (xoá + chèn đoạn, upsert summary) → chuyển trạng thái → enqueue bước sau **sau commit**.
  - Test (Postgres + RustFS + ffmpeg thật, speech / LLM giả): đi hết `queued → completed`; **chạy mỗi bước 2 lần → không trùng đoạn / summary**; job của attempt cũ → bỏ qua; meeting xoá mềm giữa chừng → dừng; `sha256` sai / > 4 giờ / không có audio → `UnrecoverableError` + `failure_code`; lỗi tạm → ném lỗi thường.
  - **Race:** 2 lần preprocess song song cùng meeting → chỉ 1 lần chạy ffmpeg. Đột biến bỏ điều kiện `status` → chạy 2 lần.
- [ ] **B5 — Processor + queue + worker**
  - Việc: `MeetingsCoreModule`, processor cho `default` / `transcription`, `WORKER_QUEUES`, retry / backoff, xử lý sự kiện `failed` (**chỉ** khi hết lượt hoặc `UnrecoverableError` → `failed` + `failure_code`, có điều kiện `attempt`), graceful shutdown (kill whisper, job chạy lại ở worker sau).
  - Test (e2e, Redis thật, worker chạy trong test, provider giả): complete upload qua HTTP → meeting `completed`; giả lỗi 2 lần rồi thành công → `attemptsMade = 3`, `completed`; `UnrecoverableError` → `failed` ngay sau 1 lần; hết lượt → `failed`; đóng worker giữa job dài → job chạy lại ở worker mới, meeting vẫn `completed`.
- [ ] **B6 — API đọc kết quả + chạy lại**
  - Việc: các route ở bảng API trên (Q5).
  - Test (e2e): transcript phân trang đúng thứ tự `seq`; summary trước khi xong → 409; người khác → 404; retry khi `failed` → `queued` + `attempt` tăng + job `a2` trong Redis; retry khi đang chạy → 409.
  - **Race:** 2 retry song song → `attempt` chỉ tăng 1, đúng 1 job. Đột biến bỏ điều kiện `status = 'failed'` → tăng 2.
- [ ] **B7 — Lịch chạy + quét meeting kẹt**
  - Việc: upsert Job Scheduler khi worker khởi động (dọn upload / idempotency, purge kênh, quét kẹt) + processor tương ứng; quét kẹt: meeting chưa xong mà `updated_at` cũ → enqueue lại bước đúng với trạng thái (cùng `jobId` → BullMQ bỏ qua nếu job còn đó).
  - Test: 2 worker cùng khởi động → mỗi lịch đúng 1 scheduler; meeting `queued` không có job (enqueue ở M5 lỗi) → quét → chạy tới `completed`; meeting đang chạy (job active) → quét không tạo job thứ hai.
- [ ] **B8 — Docker + tài liệu chạy**
  - Việc: Dockerfile (ffmpeg, whisper.cpp build pin tag), compose (env worker, volume model), CI cài ffmpeg, README (Homebrew, tải model, chạy worker native), 09-versions.
  - Test: `docker compose up --build` → worker trong container chạy được pipeline với audio ngắn (whisper `base`, CPU).
- [ ] **B9 — Đóng mốc**
  - Việc: chạy tay end-to-end: ghi âm tiếng Việt (tự ghi hoặc `say -v Linh`) → upload → worker native (whisper `large-v3-turbo`, Metal) → transcript + tóm tắt (Claude thật nếu Q2 duyệt và có key); đo thời gian từng bước; `openapi.json`; đối chiếu tài liệu bằng script; ghi "Điều học được".

## Tiêu chí hoàn thành

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` xanh
- [ ] `pnpm test:e2e` xanh ở local và CI (CI có ffmpeg); mọi chỗ chạy trùng / song song đã được đột biến
- [ ] Mọi bước pipeline idempotent: chạy lại cùng job không tạo dữ liệu trùng
- [ ] Không có process con mồ côi khi timeout / shutdown; dừng worker không làm mất job
- [ ] Upload file ghi âm tiếng Việt → transcript + tóm tắt tự xuất hiện (chạy tay, whisper thật)
- [ ] `openapi.json` đã cập nhật; `docs/design/` khớp code (02, 03, 05, 06 §1.2, 07, 09, 10)

## Điều sẽ học

- Process con trong Node: `spawn` không qua shell, stdio, đọc theo dòng, timeout, kill, process mồ côi / zombie, `AbortSignal`
- Stream S3 ↔ file ↔ process con, tính hash trong lúc stream
- BullMQ: worker lifecycle, retry / backoff, `UnrecoverableError`, sự kiện `failed` bắn mỗi lần thử (bẫy), job stalled, graceful shutdown, Job Scheduler chạy đúng một lần
- State machine bằng UPDATE có điều kiện + `attempt` làm fencing token; ghi kết quả kiểu thay thế để chạy lại an toàn
- LLM trong backend: structured output, map-reduce cho văn bản dài, phân loại lỗi tạm / vĩnh viễn, test bằng stub server
- Cột generated `tsvector` với text search config riêng

## Điều học được / bẫy gặp phải

(Ghi trong lúc làm)
