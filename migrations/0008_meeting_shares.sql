CREATE TABLE "meeting_shares" (
	"meeting_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"shared_by" uuid,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_shares_pk" PRIMARY KEY("meeting_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_meeting_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_channel_fk" FOREIGN KEY ("channel_id","org_id") REFERENCES "public"."channels"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_shares" ADD CONSTRAINT "meeting_shares_shared_by_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_shares_channel_shared_idx" ON "meeting_shares" USING btree ("channel_id","shared_at" DESC NULLS LAST,"meeting_id" DESC NULLS LAST);