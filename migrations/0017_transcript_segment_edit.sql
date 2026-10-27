ALTER TABLE "transcript_segments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD COLUMN "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_edited_by_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_segments_edited_by_idx" ON "transcript_segments" USING btree ("edited_by") WHERE "transcript_segments"."edited_by" is not null;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_version_ck" CHECK ("transcript_segments"."version" >= 1);--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_text_ck" CHECK (char_length("transcript_segments"."text") >= 1);