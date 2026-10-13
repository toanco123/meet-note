# MeetNote — Tài liệu

Thư mục này là "nguồn sự thật" về thiết kế và kế hoạch. Code chỉ hiện thực hoá những gì đã được ghi ở đây; khi đổi quyết định thì sửa tài liệu trước.

## Cấu trúc

| Đường dẫn                                                | Nội dung                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| [design/01-overview.md](design/01-overview.md)           | Tóm tắt yêu cầu, ngoài phạm vi, nhật ký quyết định                     |
| [design/02-architecture.md](design/02-architecture.md)   | Tiến trình, giao tiếp, cấu trúc thư mục, module                        |
| [design/03-database.md](design/03-database.md)           | Bảng, khoá, index, ràng buộc, chỗ cần transaction/khoá dòng            |
| [design/04-authorization.md](design/04-authorization.md) | Ma trận phân quyền tổ chức & kênh, cách hiện thực                      |
| [design/05-api.md](design/05-api.md)                     | Danh sách API, realtime events                                         |
| [design/06-flows.md](design/06-flows.md)                 | Luồng: upload → transcript → tóm tắt; báo cáo tuần; chuyển chủ kênh    |
| [design/07-conventions.md](design/07-conventions.md)     | Đặt tên, lỗi, response, phân trang, versioning, env, DTO cho Swagger   |
| [design/08-testing.md](design/08-testing.md)             | Chiến lược test                                                        |
| [design/09-versions.md](design/09-versions.md)           | Bảng phiên bản thư viện (đã kiểm tra 2026-10-13)                       |
| [design/10-roadmap.md](design/10-roadmap.md)             | Lộ trình theo mốc                                                      |
| [plans/](plans/)                                         | Plan chi tiết cho từng mốc — mỗi mốc một file, viết **trước** khi code |

## Quy trình làm một mốc

1. Copy [plans/_template.md](plans/_template.md) thành `plans/Mx-ten-moc.md`.
2. Viết mục tiêu, phạm vi, các bước nhỏ (mỗi bước build + test được), tiêu chí hoàn thành.
3. Nếu mốc làm thay đổi thiết kế (bảng, API, quyền) → sửa file trong `design/` cùng lúc.
4. Code theo từng bước, tick checklist trong plan.
5. Kết thúc mốc: ghi "Điều đã học / bẫy gặp phải" vào cuối file plan.
