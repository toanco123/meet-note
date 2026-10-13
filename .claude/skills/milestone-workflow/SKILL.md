---
name: milestone-workflow
description: Quy trình làm một mốc (milestone) của MeetNote — viết plan vào docs/plans TRƯỚC khi code, làm từng bước nhỏ có test, rồi đóng mốc bằng checklist và ghi bài học. Dùng skill này mỗi khi người dùng muốn bắt đầu, lên kế hoạch, tiếp tục hoặc kết thúc một phần việc của dự án, ví dụ "bắt đầu M1", "làm phần auth", "lên plan cho upload", "làm tiếp", "phần tiếp theo", "xong M2 chưa", "chốt mốc", kể cả khi họ không nói chữ "milestone". Use when starting, planning, resuming or closing any MeetNote milestone or feature chunk.
---

# Quy trình làm một mốc

MeetNote là project **học sâu**. Người dùng muốn mọi phần việc được chia nhỏ, có plan viết thành tài liệu trước khi code, và cuối mỗi mốc có ghi lại điều đã học. Plan là nơi người dùng đọc, chỉnh phạm vi và đối chiếu sau này. Vì vậy đừng nhảy thẳng vào code.

Nguồn sự thật:

- `docs/design/10-roadmap.md`: danh sách mốc M0–M11 và "điều sẽ học" của từng mốc
- `docs/design/*.md`: thiết kế (DB, quyền, API, luồng, quy ước)
- `docs/plans/_template.md`: khuôn plan
- `docs/plans/Mx-*.md`: plan của các mốc đã/đang làm

## 1. Bắt đầu một mốc

1. **Đọc bối cảnh.**
   - Đọc dòng của mốc trong `10-roadmap.md` và các mục design liên quan.
   - Đọc plan mốc trước, đặc biệt "Tiêu chí hoàn thành" và "Điều học được / bẫy gặp phải". Mốc trước còn tiêu chí chưa tick thì báo người dùng trước.
2. **Tạo plan.**
   - Copy `docs/plans/_template.md` thành `docs/plans/Mx-<slug>.md`, ví dụ `M1-auth.md`.
   - Điền: mục tiêu, ngoài phạm vi, thay đổi thiết kế (bảng / API / quyền), dependency mới, các bước, tiêu chí hoàn thành.
3. **Chia bước.** Mỗi bước `B1..Bn`:
   - chạy được và có test, tương ứng **một commit**;
   - ghi rõ _việc gì_ và _test gì_;
   - đi từ trong ra ngoài: schema + migration → repository + integration test → service/policy + unit test → controller + e2e → Swagger/openapi.json.
4. **Cập nhật design cùng lúc.** Mốc thêm bảng/API/quyền thì sửa `03-database.md`, `05-api.md`, `04-authorization.md` ngay trong plan, không để code đi trước tài liệu.
5. **Dừng lại để người dùng duyệt plan.** Tóm tắt ngắn: các bước, quyết định đáng chú ý, điều sẽ học. Chờ đồng ý rồi mới code. Đây là project học, người dùng có thể muốn tự làm một số bước hoặc đổi phạm vi.

Dependency mới thì làm theo skill `add-dependency`, không cài theo trí nhớ.

## 2. Làm từng bước

- Làm **một bước một lần**. Chạy kiểm tra (mục 4) xong mới tick `[x]` trong plan.
- Khi viết code, giải thích ngắn _vì sao_ chọn cách đó và _bẫy_ nào đang tránh. Người dùng muốn học, không chỉ muốn code chạy.
- Gặp bẫy thật (lỗi lạ, hành vi bất ngờ của thư viện) thì ghi ngay vào mục "Điều học được" của plan, kèm nguyên nhân và cách xử lý.
- Phát hiện thiết kế sai thì dừng lại, sửa `docs/design/` và báo người dùng. Không lặng lẽ code khác thiết kế.
- Chỉ commit khi người dùng yêu cầu. Nhánh `mx-<slug>`, commit theo Conventional Commits, ví dụ `feat(auth): rotate refresh token with reuse detection`.

Các skill chuyên đề hay dùng trong lúc làm: `drizzle-schema`, `db-transactions`, `nest-endpoint`, `authorization`, `bullmq-jobs`, `testing`.

## 3. Đóng mốc

1. Chạy đủ kiểm tra ở mục 4. Lệnh nào không chạy được (vd thiếu Docker) thì ghi rõ trong plan và nói với người dùng. **Không** báo "xong" khi chưa thấy kết quả.
2. `pnpm build && pnpm openapi:export`, kiểm tra diff `openapi.json` khớp với API đã thêm.
3. Đối chiếu tài liệu với code: bảng/cột/index trong `03-database.md`, route trong `05-api.md`, ma trận trong `04-authorization.md`, phiên bản trong `09-versions.md`.
4. Điền "Điều học được / bẫy gặp phải" bằng **những gì thực sự gặp**, cụ thể đến tên hàm/lỗi, không viết chung chung. Xem plan M0 làm mẫu.
5. Đổi trạng thái plan thành `Xong`, tick tiêu chí hoàn thành.
6. Đề xuất mốc tiếp theo, nhưng chưa tạo plan khi người dùng chưa đồng ý.

## 4. Lệnh kiểm tra

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm openapi:export     # openapi.json phải được commit cùng code
pnpm test:e2e                          # cần Docker (Testcontainers)
```

Máy chưa cài pnpm global thì dùng `npx -y pnpm@12.11.2 <lệnh>`.
