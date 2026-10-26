ALTER TABLE "weekly_reports" ADD COLUMN "requested_trigger" text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_requested_by_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weekly_reports_requested_by_idx" ON "weekly_reports" USING btree ("requested_by") WHERE "weekly_reports"."requested_by" is not null;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_trigger_ck" CHECK ("weekly_reports"."requested_trigger" in ('scheduled', 'manual'));