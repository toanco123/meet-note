CREATE TABLE "action_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"source_index" integer,
	"task" text NOT NULL,
	"owner_name" text,
	"assignee_id" uuid,
	"due_text" text,
	"due_date" date,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_items_status_ck" CHECK ("action_items"."status" in ('open', 'done', 'dismissed')),
	CONSTRAINT "action_items_origin_ck" CHECK ("action_items"."origin" in ('ai', 'manual')),
	CONSTRAINT "action_items_version_ck" CHECK ("action_items"."version" >= 1),
	CONSTRAINT "action_items_task_length_ck" CHECK (char_length("action_items"."task") between 1 and 500),
	CONSTRAINT "action_items_owner_name_length_ck" CHECK (char_length("action_items"."owner_name") between 1 and 200),
	CONSTRAINT "action_items_due_text_length_ck" CHECK (char_length("action_items"."due_text") between 1 and 200),
	CONSTRAINT "action_items_source_ck" CHECK (("action_items"."origin" = 'ai' and "action_items"."source_index" is not null and "action_items"."source_index" >= 0) or ("action_items"."origin" = 'manual' and "action_items"."source_index" is null)),
	CONSTRAINT "action_items_completed_ck" CHECK (("action_items"."status" = 'done') = ("action_items"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_meeting_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_completed_by_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_items_ai_source_uq" ON "action_items" USING btree ("meeting_id","source_index") WHERE "action_items"."origin" = 'ai';--> statement-breakpoint
CREATE INDEX "action_items_meeting_idx" ON "action_items" USING btree ("meeting_id","id");--> statement-breakpoint
CREATE INDEX "action_items_org_assignee_due_idx" ON "action_items" USING btree ("org_id","assignee_id","status","due_date","id");--> statement-breakpoint
CREATE INDEX "action_items_completed_by_idx" ON "action_items" USING btree ("completed_by") WHERE "action_items"."completed_by" is not null;--> statement-breakpoint
CREATE INDEX "action_items_created_by_idx" ON "action_items" USING btree ("created_by") WHERE "action_items"."created_by" is not null;--> statement-breakpoint
-- Viết tay (M12 Q5): người được giao rời tổ chức thì việc ở lại, `assignee_id` về NULL.
-- `ON DELETE SET NULL (assignee_id)` — PostgreSQL 15+, chỉ null MỘT cột của composite FK (xem
-- 0007_meetings_owner_fk.sql: `SET NULL` cho cả hai cột sẽ làm `org_id NOT NULL` vỡ). Index phía
-- tham chiếu: `action_items_org_assignee_due_idx` (org_id, assignee_id, …), cố ý không partial.
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_assignee_fk"
  FOREIGN KEY ("org_id", "assignee_id")
  REFERENCES "public"."organization_members" ("org_id", "user_id")
  ON DELETE SET NULL ("assignee_id");--> statement-breakpoint
-- Viết tay (M12 Q10): RLS ranh giới tổ chức, cùng mẫu 0012 / 0013 / 0015. Worker (BYPASSRLS) chèn việc
-- AI trong pipeline; api chỉ thấy việc của tổ chức trong ngữ cảnh `app.org_id`.
ALTER TABLE action_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE action_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY action_items_org_isolation ON action_items
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
