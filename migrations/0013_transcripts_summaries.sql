CREATE TABLE "meeting_summaries" (
	"meeting_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_summaries_tokens_ck" CHECK ("meeting_summaries"."input_tokens" >= 0 and "meeting_summaries"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transcript_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"meeting_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"speaker" text,
	"text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('meetnote_vi'::regconfig, "transcript_segments"."text")) STORED,
	CONSTRAINT "transcript_segments_meeting_seq_uq" UNIQUE("meeting_id","seq"),
	CONSTRAINT "transcript_segments_seq_ck" CHECK ("transcript_segments"."seq" >= 0),
	CONSTRAINT "transcript_segments_time_ck" CHECK ("transcript_segments"."start_ms" >= 0 and "transcript_segments"."end_ms" >= "transcript_segments"."start_ms")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_ck";--> statement-breakpoint
ALTER TABLE "meeting_summaries" ADD CONSTRAINT "meeting_summaries_meeting_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_meeting_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_segments_search_idx" ON "transcript_segments" USING gin ("search");--> statement-breakpoint
CREATE INDEX "meetings_stuck_idx" ON "meetings" USING btree ("updated_at") WHERE "meetings"."status" in ('queued', 'preprocessing', 'transcribing', 'summarizing') and "meetings"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_failure_code_ck" CHECK ("meetings"."failure_code" is null or "meetings"."failure_code" in ('SOURCE_CHECKSUM_MISMATCH', 'MEDIA_UNREADABLE', 'MEDIA_NO_AUDIO', 'MEDIA_TOO_LONG', 'TRANSCRIBE_FAILED', 'SUMMARIZE_FAILED'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_ck" CHECK ("notifications"."type" in ('channel.member_added', 'channel.ownership_transferred', 'org.join_request_approved', 'meeting.shared', 'meeting.completed', 'meeting.failed'));--> statement-breakpoint
-- Viết tay (M6 Q8): RLS ranh giới tổ chức cùng mẫu 0012 — hai bảng con mang org_id của meeting.
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transcript_segments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY transcript_segments_org_isolation ON transcript_segments
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());--> statement-breakpoint
ALTER TABLE meeting_summaries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meeting_summaries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY meeting_summaries_org_isolation ON meeting_summaries
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
