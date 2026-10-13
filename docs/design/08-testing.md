# 08 — Chiến lược test

## 1. Ba tầng test

| Tầng            | Lệnh            | Phạm vi                                                                                      | Phụ thuộc                       | Tốc độ         |
| --------------- | --------------- | -------------------------------------------------------------------------------------------- | ------------------------------- | -------------- |
| **Unit**        | `pnpm test`     | Hàm thuần: policy, cursor codec, tính tuần theo múi giờ, format SRT/VTT, map lỗi             | Không có I/O                    | ms             |
| **Integration** | `pnpm test:int` | Repository + service chạy trên **Postgres thật**: transaction, khoá dòng, constraint, search | Testcontainers Postgres 18      | giây           |
| **E2E**         | `pnpm test:e2e` | App Nest đầy đủ + supertest qua HTTP, worker với Redis thật, WebSocket client                | Testcontainers Postgres + Redis | giây–chục giây |

File test:

- Unit đặt cạnh code: `*.spec.ts`.
- Integration: `*.int-spec.ts`.
- E2E nằm trong `test/e2e/*.e2e-spec.ts`.

## 2. Database thật với Testcontainers

```
globalSetup (1 lần cho cả lượt chạy)
  ├─ start PostgreSqlContainer('postgres:18.6-alpine')
  ├─ chạy migration vào database "template_meetnote"
  └─ provide(DATABASE_URL_TEMPLATE)

mỗi file test
  ├─ CREATE DATABASE test_<random> TEMPLATE template_meetnote   (~50ms)
  ├─ tạo Nest app / Drizzle trỏ vào DB này
  └─ afterAll: DROP DATABASE
```

- Mỗi file test có **database riêng**, nên chạy song song được, không cần dọn dữ liệu giữa các file.
- Trong một file, các test có thể dùng chung dữ liệu nền (`beforeAll`) và tạo dữ liệu riêng bằng factory (`createUser()`, `createOrg({ owner })`).
- **Không** mock Drizzle hoặc DB trong integration test. Mục tiêu là kiểm tra SQL, constraint và lock thật.

> **Bẫy:**
>
> - `CREATE DATABASE … TEMPLATE` lỗi nếu còn kết nối vào template. Sau khi migrate phải đóng hết pool trỏ vào template.
> - Ryuk (container dọn dẹp của Testcontainers) cần quyền truy cập Docker socket. Trên CI GitHub Actions thì ổn. Nếu dùng Colima/OrbStack thì có thể phải set `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`.

## 3. Test concurrency (trọng tâm của project)

Mỗi chỗ có transaction/khoá trong [03-database.md §7](03-database.md) cần ít nhất một test kiểu:

```ts
it('2 lần regenerate song song khi count=2 → đúng 1 thành công', async () => {
  await setRegenerateCount(reportId, 2);
  const results = await Promise.allSettled([
    service.regenerate(actor, reportId),
    service.regenerate(actor, reportId),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(rejectedCodes(results)).toEqual(['REPORT_REGENERATE_LIMIT']);
  expect(await getRegenerateCount(reportId)).toBe(3);
});
```

- Hai lời gọi phải dùng **2 connection khác nhau** (pool ≥ 2). Nếu cùng 1 connection thì không có tranh chấp thật.
- Muốn chứng minh lock thật sự có tác dụng: tạm bỏ `FOR UPDATE` thì test phải **đỏ**. Ghi nhận lại điều này trong plan của mốc.
- Đôi khi cần ép thứ tự chạy: dùng 2 transaction thủ công và `pg_sleep`/barrier. Viết helper `runConcurrently`.

## 4. E2E phân quyền theo bảng

```ts
const cases = [
  // [actor,   action,                     expectedStatus]
  ['owner',  'POST /channels/:id/archive', 200],
  ['admin',  'POST /channels/:id/archive', 403],
  ['guest',  'GET  /channels/:id/members', 403],
  ['outsider-private', 'GET /channels/:id', 404],
] as const;
it.each(cases)('%s → %s → %i', async (actor, action, status) => { … });
```

Ma trận trong [04-authorization.md](04-authorization.md) được chuyển thành bảng test này. Đổi ma trận thì đổi test.

## 5. Worker & queue

- Processor nhận dependency qua interface: `SpeechToText`, `Summarizer`, `ObjectStorage`, `Clock`. Test dùng Fake (trả kết quả cố định, có thể cấu hình để ném lỗi lần 1 rồi thành công lần 2).
- Integration với BullMQ thật (Redis container): add job, chờ `job.waitUntilFinished(queueEvents)`, kiểm tra DB.
- Test retry: Fake lỗi 2 lần đầu, kiểm tra `attemptsMade` và trạng thái cuối cùng.
- Test idempotency: chạy processor **2 lần** cho cùng job, DB không có dữ liệu trùng.
- Whisper thật **không** chạy trên CI. Có một test thủ công `pnpm test:whisper` với file audio 10 giây để kiểm tra integration.

## 6. Thời gian & cron

- Inject `Clock` (`now(): Date`) thay vì gọi `new Date()` trực tiếp trong service. Test dùng `FixedClock`.
- Unit test hàm `previousWeekStart(firedAt, 'Asia/Ho_Chi_Minh')` với các ca biên: 07:59 thứ 2, 00:30 thứ 2 giờ VN (= 17:30 chủ nhật UTC), cuối năm, tuần chứa 1/1.

## 7. Hợp đồng API

- `pnpm openapi:export` sinh `openapi.json` (commit vào repo).
- CI build xong chạy lại export rồi `git diff --exit-code openapi.json`. API thay đổi mà không cập nhật file thì CI đỏ. Như vậy mọi thay đổi API đều hiện rõ trong PR.

## 8. CI (GitHub Actions)

```
lint (oxlint + prettier --check + tsc --noEmit)
  → unit
  → integration + e2e (Docker sẵn có trên ubuntu runner)
  → build + openapi diff
  → docker build (không push)
```

Không đặt mục tiêu coverage cứng. Thay vào đó yêu cầu: mỗi quy tắc trong ma trận quyền và mỗi chỗ khoá dòng đều có test.
