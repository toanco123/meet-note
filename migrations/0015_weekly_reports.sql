CREATE TABLE "weekly_report_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"report_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" uuid,
	"content" jsonb NOT NULL,
	"meeting_ids" uuid[] NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_report_versions_report_version_uq" UNIQUE("report_id","version"),
	CONSTRAINT "weekly_report_versions_version_ck" CHECK ("weekly_report_versions"."version" >= 1),
	CONSTRAINT "weekly_report_versions_trigger_ck" CHECK ("weekly_report_versions"."trigger" in ('scheduled', 'manual')),
	CONSTRAINT "weekly_report_versions_tokens_ck" CHECK ("weekly_report_versions"."input_tokens" >= 0 and "weekly_report_versions"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "weekly_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"channel_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"regenerate_count" smallint DEFAULT 0 NOT NULL,
	"current_version" integer,
	"last_error" text,
	"generation_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_reports_channel_week_uq" UNIQUE("channel_id","week_start"),
	CONSTRAINT "weekly_reports_id_org_uq" UNIQUE("id","org_id"),
	CONSTRAINT "weekly_reports_status_ck" CHECK ("weekly_reports"."status" in ('pending', 'generating', 'completed', 'failed', 'skipped')),
	CONSTRAINT "weekly_reports_regenerate_ck" CHECK ("weekly_reports"."regenerate_count" between 0 and 3),
	CONSTRAINT "weekly_reports_version_ck" CHECK ("weekly_reports"."current_version" is null or "weekly_reports"."current_version" >= 1),
	CONSTRAINT "weekly_reports_completed_ck" CHECK ("weekly_reports"."status" <> 'completed' or "weekly_reports"."current_version" is not null),
	CONSTRAINT "weekly_reports_monday_ck" CHECK (extract(isodow from "weekly_reports"."week_start") = 1)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_ck";--> statement-breakpoint
ALTER TABLE "weekly_report_versions" ADD CONSTRAINT "weekly_report_versions_report_fk" FOREIGN KEY ("report_id","org_id") REFERENCES "public"."weekly_reports"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_report_versions" ADD CONSTRAINT "weekly_report_versions_triggered_by_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_channel_fk" FOREIGN KEY ("channel_id","org_id") REFERENCES "public"."channels"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_report_versions_triggered_by_idx" ON "weekly_report_versions" USING btree ("triggered_by") WHERE "weekly_report_versions"."triggered_by" is not null;--> statement-breakpoint
CREATE INDEX "weekly_reports_week_status_idx" ON "weekly_reports" USING btree ("week_start","status");--> statement-breakpoint
CREATE INDEX "weekly_reports_stuck_idx" ON "weekly_reports" USING btree ("updated_at") WHERE "weekly_reports"."status" in ('pending', 'generating');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_ck" CHECK ("notifications"."type" in ('channel.member_added', 'channel.ownership_transferred', 'org.join_request_approved', 'meeting.shared', 'meeting.completed', 'meeting.failed', 'report.ready'));--> statement-breakpoint
-- Viết tay (M9 Q9): RLS ranh giới tổ chức cùng mẫu 0012 / 0013 — hai bảng mang org_id của kênh.
-- Worker (BYPASSRLS) đọc xuyên tổ chức khi tick; api chỉ thấy báo cáo của tổ chức trong ngữ cảnh.
ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE weekly_reports FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY weekly_reports_org_isolation ON weekly_reports
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint
ALTER TABLE weekly_report_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE weekly_report_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY weekly_report_versions_org_isolation ON weekly_report_versions
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
