---
name: bullmq-jobs
description: Thêm queue, job và processor BullMQ cho tiến trình worker của MeetNote — payload chỉ chứa ID, jobId chống trùng (không có dấu hai chấm), enqueue sau commit, processor idempotent mở đầu bằng UPDATE có điều kiện, retry/backoff, UnrecoverableError, Job Scheduler cho cron có timezone, báo tiến độ, graceful shutdown và test với Redis thật. Dùng khi làm pipeline xử lý cuộc họp (ffmpeg, whisper.cpp, tóm tắt AI), báo cáo tuần, fan-out thông báo, job dọn dẹp/purge, hoặc khi người dùng nhắc tới queue, worker, job, cron, retry, background task, "chạy nền". Use for any background processing in this repo.
---

# Queue & worker với BullMQ

Thiết kế liên quan:

- `docs/design/02-architecture.md` §2: nguyên tắc giao tiếp api ↔ worker
- `docs/design/06-flows.md` §1.2: pipeline meeting
- `docs/design/06-flows.md` §2: báo cáo tuần

Kết nối BullMQ khai báo ở `src/infra/queue/queue.module.ts`, tên queue trong `QueueName`.

## Quy ước

| Thứ          | Quy ước                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue        | Theo **đặc tính tải**: `default` (job ngắn), `transcription` (CPU nặng, concurrency 1)                                                          |
| Tên job      | `domain.action`: `meeting.preprocess`, `meeting.transcribe`, `weekly-report.tick`                                                               |
| Payload      | Chỉ **ID** + `requestId` để nối log. Worker tự đọc trạng thái mới nhất từ DB                                                                    |
| `jobId`      | `<tên-job>.<entityId>[.<lần>]`, ví dụ `meeting.transcribe.<uuid>.a1`. **BullMQ cấm dấu `:`** trong custom id (lỗi `Custom Id cannot contain :`) |
| Kiểu payload | Khai báo trong `src/infra/queue/` để api (producer) và worker (consumer) dùng chung                                                             |

Vì sao `jobId` phải có tên bước và số lần: BullMQ **bỏ qua** `add()` nếu jobId đã tồn tại, kể cả job đã completed/failed còn được giữ lại (`removeOnComplete`/`removeOnFail`). Các bước dùng chung ID thì bước sau bị nuốt. Retry thủ công mà dùng ID cũ cũng bị nuốt.

## Producer (api hoặc processor khác)

```ts
@Module({ imports: [BullModule.registerQueue({ name: QueueName.Default })] })
export class MeetingsCoreModule {}

constructor(@InjectQueue(QueueName.Default) private readonly queue: Queue) {}

// SAU khi transaction commit:
await this.queue.add(
  'meeting.preprocess',
  { meetingId, requestId },
  { jobId: `meeting.preprocess.${meetingId}.a${attempt}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
);
```

Enqueue trước commit thì worker có thể chạy khi dữ liệu chưa có. Commit xong mà enqueue lỗi thì có job dọn dẹp quét bản ghi kẹt (`status = queued` quá N phút) để enqueue lại.

## Processor (chỉ đăng ký trong WorkerModule)

```ts
@Processor(QueueName.Default, { concurrency: 5 })
export class DefaultQueueProcessor extends WorkerHost {
  constructor(private readonly meetings: MeetingPipelineService /* ... */) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'meeting.preprocess':
        return this.meetings.preprocess(job.data.meetingId, job);
      // ...
      default:
        throw new UnrecoverableError(`Job không xác định: ${job.name}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    /* hết attempts → status = failed, thông báo */
  }
}
```

- **Processor không được nằm trong module mà `AppModule` import**, nếu không api cũng tiêu thụ job. Đặt processor trong module riêng chỉ `WorkerModule` import. Từ M6, chọn queue theo env `WORKER_QUEUES`.
- Một queue có nhiều tên job thì dispatch bằng `switch (job.name)`. Logic nằm ở service để test được mà không cần BullMQ.

## Processor phải idempotent

Job **có thể chạy hơn một lần**: worker chết giữa chừng, job bị đánh dấu stalled, hoặc retry. Vì vậy:

1. **Mở đầu bằng UPDATE có điều kiện:** `UPDATE … SET status = 'transcribing' WHERE id = $1 AND status = 'preprocessing' RETURNING id`. 0 dòng thì log rồi `return`, không ném lỗi.
2. **Ghi kết quả kiểu thay thế:** delete + insert trong transaction, hoặc upsert. Không append.
3. **Không giữ transaction trong lúc chạy lâu** (S3, ffmpeg, whisper, LLM).
4. Lỗi vĩnh viễn (file hỏng, quá 4 giờ, 4xx từ LLM trừ 429) thì ném `UnrecoverableError` để fail ngay không retry. Lỗi tạm thời thì ném `Error` thường để BullMQ retry theo backoff.
5. Tiến độ: `await job.updateProgress(percent)`, cộng thêm emit realtime (M7) **chỉ ở mốc có ý nghĩa** (vài % một lần), đừng emit mỗi dòng stdout.

## Cron (Job Scheduler)

```ts
// Worker, OnApplicationBootstrap — upsert nên chạy nhiều lần/nhiều instance vẫn chỉ có 1 lịch
await this.queue.upsertJobScheduler(
  'weekly-report-tick',
  { pattern: '0 8 * * 1', tz: 'Asia/Ho_Chi_Minh' },
  { name: 'weekly-report.tick', data: {} },
);
```

- Không dùng `@nestjs/schedule` cho việc phải chạy **đúng một lần**, vì nó chạy ở mọi instance.
- Tick chỉ fan-out ra job nhỏ cho từng kênh. Idempotency cuối cùng nằm ở DB (`ON CONFLICT` theo khoá tự nhiên).
- Dùng `Asia/Ho_Chi_Minh` (tên chuẩn IANA), không dùng `Asia/Saigon`.

## Child process (ffmpeg, whisper.cpp)

- `spawn` với mảng argument, **không** ghép chuỗi vào shell (tránh injection từ tên file).
- Ghi file tạm vào thư mục riêng của job, xoá trong `finally`.
- Đọc tiến độ từ stdout/stderr theo dòng. Có timeout. Khi worker shutdown thì kill child để job được retry.
- Gọi qua interface (`SpeechToText`, `Summarizer`) để test dùng Fake.

## Test

- **Unit/integration:** gọi thẳng service mà processor dispatch tới, với Fake provider và Postgres thật. Chạy **2 lần** cùng input thì DB không có dữ liệu trùng.
- **E2E với Redis thật:** `queue.add(...)`, chờ `job.waitUntilFinished(queueEvents, 30_000)`, rồi kiểm tra DB.
- **Retry:** Fake lỗi 2 lần đầu rồi thành công. Kiểm tra `attemptsMade` và trạng thái cuối.
- Không chạy Whisper thật trên CI.

## Bẫy

- Redis cho BullMQ phải đặt `maxmemory-policy noeviction` (đã cấu hình trong `compose.yaml`).
- Kết nối worker cần `maxRetriesPerRequest: null`. BullMQ tự đặt khi nhận `connection` options, nhưng **không** tự đặt nếu truyền vào một instance ioredis tự tạo.
- Payload lớn (transcript) làm phình Redis. Lưu ở DB/S3, payload chỉ chứa ID.
