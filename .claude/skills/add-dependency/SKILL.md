---
name: add-dependency
description: Thêm hoặc nâng cấp thư viện npm cho MeetNote có kiểm chứng — tra phiên bản ổn định mới nhất trên registry, kiểm tra peer dependency với NestJS 12, TypeScript 6 và ESM, xử lý chính sách pnpm 12 (allowBuilds cho build script, minimumReleaseAge), cập nhật bảng docs/design/09-versions.md. Dùng mỗi khi cài package mới, nâng phiên bản, chọn giữa các thư viện, gặp lỗi ERR_PNPM_IGNORED_BUILDS hoặc lỗi peer dependency, hoặc khi một mốc cần dependency mới (argon2, @nestjs/jwt, @aws-sdk/client-s3, socket.io…). Use whenever a dependency is added, upgraded or chosen in this repo.
---

# Thêm / nâng cấp dependency

Người dùng yêu cầu **kiểm tra phiên bản thật tại thời điểm làm**, không dùng phiên bản theo trí nhớ. Bảng chuẩn nằm ở `docs/design/09-versions.md`.

## Các bước

1. **Tra registry:**
   ```bash
   npm view <pkg> version dist-tags --json
   npm view <pkg>@<ver> peerDependencies engines type exports --json
   npm view <pkg> time --json | tail -5        # ngày phát hành
   ```
   Chọn tag `latest`. Không dùng beta/rc/next trừ khi người dùng đồng ý.
2. **Kiểm tra tương thích:**
   - peer với `@nestjs/* 12`, `typescript ~6.0` (dự án **chưa** lên TS 7), Node 24;
   - ESM: package có `exports`/`"type": "module"`, hoặc là CJS nhưng import được bằng named import. Thử nhanh: `node -e "import('<pkg>').then(m => console.log(Object.keys(m)))"`;
   - có native addon / install script không, xem bước 4.
3. **Cài đúng phiên bản đã tra:** `pnpm add <pkg>@^x.y.z` (dev: `-D`). Không cài không kèm số phiên bản.
4. **Chính sách pnpm 12** (trong `pnpm-workspace.yaml`):
   - `ERR_PNPM_IGNORED_BUILDS`: pnpm chặn script của dependency. Cho phép thì dùng `pnpm approve-builds <pkg>`, từ chối thì dùng `pnpm approve-builds '!<pkg>'`.
     - **Cho phép** khi package thật sự cần build để chạy, vd tải binary/biên dịch native (`esbuild`, `argon2`).
     - **Từ chối** telemetry (`@scarf/scarf`) và native addon tuỳ chọn có fallback JS.
   - `minimumReleaseAge`: bản phát hành quá mới bị từ chối. Chỉ thêm ngoại lệ vào `minimumReleaseAgeExclude` khi thật sự cần bản đó. Nói rõ với người dùng vì đây là lớp phòng thủ supply-chain.
5. **Kiểm chứng:** `pnpm typecheck && pnpm test && pnpm build`. Package dùng lúc runtime thì chạy thử thêm (smoke test app hoặc e2e).
6. **Ghi lại:**
   - thêm/sửa dòng trong `docs/design/09-versions.md` (phiên bản, mốc bắt đầu dùng);
   - vấn đề tương thích nào gặp thì thêm vào bảng "Lưu ý tương thích";
   - nếu là dependency của một mốc thì ghi vào mục dependency trong plan của mốc đó.

## Các quyết định phiên bản đang có hiệu lực

| Thứ        | Giữ ở                                                               | Khi nào xem lại                                                                              |
| ---------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| TypeScript | `~6.0.x`                                                            | Khi `@nestjs/swagger` khai báo peer hỗ trợ TS 7                                              |
| Drizzle    | `drizzle-orm 0.45.x`, `drizzle-kit 0.31.x`                          | Khi 1.0 lên `latest`. Đọc migration guide trước                                              |
| Node       | 24 LTS                                                              | Khi Node 26 lên LTS: sửa `.nvmrc`, `engines`, `NODE_VERSION` trong Dockerfile, `@types/node` |
| pnpm       | 12.11.2 (`packageManager`)                                          | Cập nhật cùng `PNPM_VERSION` trong Dockerfile                                                |
| Image      | `postgres:18.6-alpine`, `redis:8.8.3-alpine`, `rustfs/rustfs:1.0.1` | Sửa đồng thời `compose.yaml` và `test/support/database.ts`                                   |

## Ghi chú

- Máy chưa có pnpm global thì dùng `npx -y pnpm@12.11.2 <lệnh>`.
- Đừng thêm thư viện cho việc mà thư viện chuẩn của Node hoặc dependency sẵn có đã làm được. Mỗi dependency là thêm bề mặt supply-chain.
- Đổi phiên bản Docker image thì đổi ở **mọi** chỗ cùng lúc, nếu không test chạy một bản còn compose chạy bản khác.
