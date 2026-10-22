-- M11 B6: quyền tối thiểu. App KHÔNG còn kết nối bằng chủ schema / superuser.
-- Role NHÓM, NOLOGIN, không mật khẩu (migration nằm trong git). User đăng nhập (LOGIN + mật khẩu từ
-- env) do bước provision của script migrate tạo và cho làm thành viên nhóm (`provision-roles.ts`).
-- BẪY: thuộc tính role (LOGIN, BYPASSRLS, SUPERUSER…) KHÔNG kế thừa qua membership — chỉ quyền trên
-- đối tượng (GRANT) kế thừa. Vì thế GRANT nằm ở nhóm, BYPASSRLS (M11 B7) đặt trên user đăng nhập.
-- Role là đối tượng của CẢ cluster → chỉ tạo khi chưa có (test: nhiều database cùng một cluster).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meetnote_app') THEN
    CREATE ROLE meetnote_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'meetnote_worker') THEN
    CREATE ROLE meetnote_worker NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO meetnote_app, meetnote_worker;--> statement-breakpoint
-- Chỉ DML. Không DDL (không phải chủ bảng), không TRUNCATE / REFERENCES / TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meetnote_app, meetnote_worker;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO meetnote_app, meetnote_worker;--> statement-breakpoint
-- audit_logs chỉ ghi thêm: lớp QUYỀN (42501) trước lớp trigger (23001, vẫn chặn cả chủ schema).
REVOKE UPDATE, DELETE ON audit_logs FROM meetnote_app, meetnote_worker;--> statement-breakpoint
-- Bảng / sequence do role chạy migration tạo SAU này tự có cùng quyền (bảng chỉ-ghi-thêm mới phải
-- REVOKE tường minh như trên).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meetnote_app, meetnote_worker;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO meetnote_app, meetnote_worker;
