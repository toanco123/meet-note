# Mẫu báo cáo review

Viết bằng tiếng Việt, thuật ngữ kỹ thuật giữ tiếng Anh. Ngắn gọn, mỗi phát hiện tự đứng được.

```markdown
## Review PR #<n> — <tiêu đề>

**Tác giả:** <login> · **Nhánh:** <head> → <base> · **Thay đổi:** +<a> −<d>, <k> file
**Thuộc mốc:** <Mx hoặc "không rõ"> · **Kết luận gợi ý:** Chặn merge | Cần sửa nhỏ | Có thể merge

### Tóm tắt
2–3 câu: PR làm gì, có khớp plan/design không.

### Phát hiện
#### [Chặn] <tên ngắn> — `path/to/file.ts:42`
- **Vấn đề:** …
- **Vì sao sai:** (kịch bản cụ thể: input/trạng thái → kết quả sai)
- **Cách sửa:** …

#### [Sửa] …
#### [Gợi ý] …

### Đã kiểm tra
| Lệnh | Kết quả |
| --- | --- |
| format:check | pass / fail / chưa chạy |
| lint | số cảnh báo (chuẩn: 6 cũ) |
| typecheck | … |
| test | … |
| test:e2e | … (nêu rõ nếu chưa chạy vì Docker) |

### Chưa kiểm tra được
Những phần thiếu ngữ cảnh hoặc chưa chạy, để không ai hiểu nhầm là đã pass.

### Điểm tốt
1–3 ý ngắn, cụ thể (vd: test concurrency chứng minh được khoá cần thiết).
```

## Quy tắc viết

- Mỗi phát hiện bắt buộc có `file:dòng` đã mở ra xác minh. Không chắc thì ghi "cần xác nhận" và nói cần xem gì.
- Xếp theo mức độ: Chặn trước, rồi Sửa, rồi Gợi ý. Không để Gợi ý lấn át Chặn.
- Không liệt kê điều đã đúng như thể đó là lỗi; không phóng đại mức độ.
- Nêu kịch bản cụ thể để tác giả tự tái hiện được, vì đây là project học.
- Đăng lên PR chỉ khi người dùng yêu cầu; bản đăng nên ngắn hơn bản gửi người review.
