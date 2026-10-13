---
name: db-transactions
description: Viết logic có transaction, khoá dòng và idempotency trên PostgreSQL bằng Drizzle trong MeetNote — SELECT FOR UPDATE, thứ tự khoá chống deadlock, kiểm tra lại sau khi khoá, UPDATE có điều kiện, INSERT ON CONFLICT, FOR UPDATE SKIP LOCKED, ghi audit trong cùng transaction, publish/enqueue sau commit, kèm test concurrency trên Postgres thật. Dùng khi làm đổi vai trò, chuyển quyền sở hữu, refresh token, link mời giới hạn lượt, duyệt yêu cầu, quota tạo lại báo cáo, chuyển trạng thái meeting, job dọn dẹp, hoặc khi người dùng hỏi về race condition, "2 request cùng lúc", lock, deadlock, transaction, idempotent. Use for any write path where concurrent requests could corrupt state.
---

# Transaction, khoá dòng, idempotency

Đây là trọng tâm học của dự án. Mỗi chỗ dùng kỹ thuật này phải có **test concurrency chứng minh nó cần thiết**. Danh sách thao tác nào dùng kỹ thuật nào nằm trong `docs/design/03-database.md` §7. Ví dụ luồng đầy đủ: `docs/design/06-flows.md` §3 (chuyển chủ kênh).

## Chọn kỹ thuật

| Tình huống                                | Kỹ thuật                                                                           | Ví dụ trong MeetNote                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Một câu UPDATE tự kiểm tra được điều kiện | **UPDATE có điều kiện** + `RETURNING`. 0 dòng = không đủ điều kiện                 | Dùng link mời (`use_count < max_uses`), chuyển trạng thái meeting |
| Tạo một lần theo khoá tự nhiên            | **`INSERT … ON CONFLICT DO NOTHING RETURNING`**                                    | Báo cáo tuần `(channel_id, week_start)`, thông báo `dedupe_key`   |
| Đọc → kiểm tra nhiều điều kiện → ghi      | **Transaction + `SELECT … FOR UPDATE`** rồi kiểm tra lại                           | Chuyển sở hữu, refresh token, quota tạo lại, complete upload      |
| Nhiều worker cùng lấy việc từ một bảng    | **`FOR UPDATE SKIP LOCKED`** theo lô                                               | Purge kênh đã xoá, dọn upload hết hạn                             |
| Việc chạy lâu (S3, Whisper, LLM)          | **Không** giữ transaction. Chuyển trạng thái bằng UPDATE có điều kiện trước và sau | Pipeline meeting                                                  |

Ưu tiên kỹ thuật **đơn giản nhất** còn đúng. Một UPDATE có điều kiện tốt hơn transaction + lock nếu đủ dùng.

## API Drizzle

```ts
// Service sở hữu ranh giới transaction. Repository nhận `executor` (db hoặc tx).
await this.db.transaction(async (tx) => {
  const [channel] = await tx.select().from(channels)
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
    .for('update');                                   // FOR UPDATE

  const rows = await tx.select().from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), inArray(channelMembers.userId, [a, b])))
    .orderBy(asc(channelMembers.userId))              // thứ tự khoá cố định
    .for('update');
  // ...
});

await tx.select().from(t).where(...).limit(100).for('update', { skipLocked: true });

const inserted = await tx.insert(weeklyReports).values(v)
  .onConflictDoNothing({ target: [weeklyReports.channelId, weeklyReports.weekStart] })
  .returning({ id: weeklyReports.id });              // [] = đã tồn tại

const moved = await db.update(meetings).set({ status: 'transcribing' })
  .where(and(eq(meetings.id, id), eq(meetings.status, 'preprocessing')))
  .returning({ id: meetings.id });                   // [] = job cũ/trùng → bỏ qua
```

`db.transaction(fn, { isolationLevel: 'serializable' })` có tồn tại, nhưng dự án mặc định dùng `read committed` + khoá tường minh. Như vậy người học thấy rõ chỗ nào đang khoá.

## Mẫu "đổi quyền" (áp cho mọi thay đổi vai trò/sở hữu)

1. `BEGIN`.
2. Khoá **dòng cha** làm mutex (`channels` cho quyền kênh, các dòng `organization_members` liên quan cho quyền org).
3. Khoá các dòng đích, **sắp theo khoá chính** (`ORDER BY user_id`), để mọi luồng khoá cùng thứ tự và không deadlock.
4. **Kiểm tra lại mọi điều kiện sau khi khoá**: actor còn quyền không, target còn là thành viên không, kênh đã lưu trữ chưa. Dữ liệu guard đọc lúc đầu có thể đã cũ.
5. Ghi theo thứ tự không vi phạm constraint, vd **hạ owner cũ → nâng owner mới**, vì partial unique index không deferrable.
6. `AuditService.record(tx, …)` trong **cùng** transaction.
7. Gom các "việc sau commit" (event realtime, job, thông báo đẩy) vào một mảng và trả ra khỏi callback.
8. `COMMIT`, rồi mới publish/enqueue.

```ts
const { result, afterCommit } = await this.db.transaction(async (tx) => {
  // ... bước 2–6
  return { result, afterCommit: [() => this.realtime.emit(...)] };
});
for (const run of afterCommit) await run();
return result;
```

Publish bên trong transaction mà transaction rollback thì client nhận event "ma". Enqueue trước commit thì worker có thể đọc DB khi dữ liệu chưa tồn tại.

## Lỗi trong transaction

- Bắt unique violation (`23505`) để trả **409 với mã cụ thể** dựa trên `constraint`. Lỗi `pg` nằm trong `error.cause`, vì Drizzle bọc lỗi. Dùng `findPgError()` trong `src/common/errors/all-exceptions.filter.ts`.
- Lỗi để lọt thì filter global trả 409 `CONFLICT` chung (23505/23503) hoặc 500.
- Chỉ retry tự động với `40001` (serialization) / `40P01` (deadlock), và chỉ khi chủ động dùng isolation cao hơn. Thấy deadlock thì sửa thứ tự khoá, đừng thêm retry.

## Test concurrency (bắt buộc cho mỗi chỗ khoá)

```ts
it('2 lần regenerate song song khi count=2 → đúng 1 thành công', async () => {
  await setRegenerateCount(reportId, 2);
  const results = await Promise.allSettled([
    service.regenerate(actor, reportId),
    service.regenerate(actor, reportId),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await getRegenerateCount(reportId)).toBe(3);
});
```

- Hai lời gọi phải đi trên **2 connection khác nhau**. Mỗi `db.transaction` lấy connection riêng từ pool, nên pool phải ≥ số luồng song song.
- **Kiểm chứng test có giá trị:** tạm bỏ `.for('update')` thì test phải **đỏ**. Ghi kết quả này vào plan của mốc ("Điều học được").
- Race khó tái hiện: dùng 2 transaction thủ công + barrier (`Promise` resolve bằng tay) để ép thứ tự xen kẽ.
- Test chạy với Postgres thật (`pnpm test:e2e`), xem skill `testing`. Không mock DB cho loại test này.

## Bẫy

- Đọc trong guard rồi ghi trong service mà không khoá + kiểm tra lại là kiểu race kinh điển TOCTOU (time-of-check to time-of-use).
- `FOR UPDATE` trên query có `JOIN` sẽ khoá dòng của **mọi** bảng trong join. Muốn khoá bảng nào thì khoá riêng bảng đó.
- Giữ transaction trong lúc gọi mạng (S3, LLM) làm cạn pool và giữ khoá lâu.
- `SELECT … FOR UPDATE` không khoá được dòng **chưa tồn tại**. Chống tạo trùng thì dùng unique constraint + `ON CONFLICT`.
- Transaction lồng trong Drizzle là savepoint. Rollback savepoint không rollback transaction ngoài.
