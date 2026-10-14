-- Migration viết tay: audit_logs CHỈ GHI THÊM (M3 Q4).
-- REVOKE UPDATE/DELETE không có tác dụng vì user ứng dụng là CHỦ của bảng (chủ bảng luôn có mọi quyền),
-- nên ép bằng trigger: mọi UPDATE/DELETE/TRUNCATE đều bị từ chối, kể cả khi code có bug.

CREATE FUNCTION audit_logs_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs là bảng chỉ ghi thêm: % bị từ chối', TG_OP
    USING ERRCODE = 'restrict_violation'; -- SQLSTATE 23001
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();
--> statement-breakpoint
-- TRUNCATE không kích hoạt trigger FOR EACH ROW → cần trigger cấp câu lệnh riêng.
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_reject_mutation();
