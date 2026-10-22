-- M11 B7: RLS = lớp phòng thủ THỨ HAI cho ranh giới tổ chức. Lớp một vẫn là code (guard, `org_id`
-- trong mọi query, composite FK). Policy chỉ giữ "đúng tổ chức của request" — KHÔNG chứa quy tắc ai
-- xem được meeting nào (điều kiện xem dùng chung ở code, 04 §3).
--
-- `app.org_id` do pool của app đặt mỗi lần cho mượn connection (OrgContext). Chưa đặt / rỗng →
-- NULL → `org_id = NULL` không bao giờ đúng → KHÔNG thấy dòng nào (an toàn mặc định).
CREATE FUNCTION app_current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN nullif(current_setting('app.org_id', true), '')::uuid;--> statement-breakpoint

-- FORCE: áp cả cho CHỦ bảng (mặc định chủ bảng được miễn). Superuser và role BYPASSRLS (worker)
-- vẫn luôn được miễn — vì thế app không được chạy bằng superuser (M11 B6).
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE channels FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channels_org_isolation ON channels
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint

ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE channel_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channel_members_org_isolation ON channel_members
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY meetings_org_isolation ON meetings
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint

ALTER TABLE meeting_shares ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meeting_shares FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY meeting_shares_org_isolation ON meeting_shares
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE uploads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY uploads_org_isolation ON uploads
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
