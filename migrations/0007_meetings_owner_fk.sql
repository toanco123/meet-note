-- Viết tay (M5 Q1): meeting ở lại tổ chức khi chủ rời / bị gỡ khỏi org.
--
-- Cần `ON DELETE SET NULL (owner_id)` — cú pháp PostgreSQL 15+, chỉ null MỘT cột của composite FK.
-- Drizzle chỉ sinh được `ON DELETE SET NULL` cho MỌI cột: Postgres sẽ chạy
-- `UPDATE meetings SET org_id = NULL, owner_id = NULL` → `org_id NOT NULL` vỡ (23502) → việc xoá
-- thành viên khỏi org THẤT BẠI (đã thử trên Postgres thật, xem plan M5).
--
-- Index cho phía tham chiếu: `meetings_org_owner_created_idx (org_id, owner_id, …)` (không partial).
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_fk"
  FOREIGN KEY ("org_id", "owner_id")
  REFERENCES "public"."organization_members" ("org_id", "user_id")
  ON DELETE SET NULL ("owner_id");
