ALTER TABLE "meetings" DROP CONSTRAINT "meetings_failure_code_ck";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "stage_token" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "stage_lease_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_meeting_uq" ON "uploads" USING btree ("meeting_id") WHERE "uploads"."meeting_id" is not null;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_failure_code_ck" CHECK ("meetings"."failure_code" is null or "meetings"."failure_code" in ('SOURCE_CHECKSUM_MISMATCH', 'MEDIA_UNREADABLE', 'MEDIA_NO_AUDIO', 'MEDIA_TOO_LONG', 'TRANSCRIBE_FAILED', 'SUMMARIZE_FAILED', 'PREPROCESS_FAILED'));