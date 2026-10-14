CREATE TABLE "channel_members" (
	"channel_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_pk" PRIMARY KEY("channel_id","user_id"),
	CONSTRAINT "channel_members_role_ck" CHECK ("channel_members"."role" in ('owner', 'admin', 'member', 'guest'))
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"weekly_report_enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_id_org_uq" UNIQUE("id","org_id"),
	CONSTRAINT "channels_visibility_ck" CHECK ("channels"."visibility" in ('public', 'private')),
	CONSTRAINT "channels_name_length_ck" CHECK (char_length("channels"."name") between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_fk" FOREIGN KEY ("channel_id","org_id") REFERENCES "public"."channels"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_org_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_one_owner_uq" ON "channel_members" USING btree ("channel_id") WHERE "channel_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "channel_members_user_idx" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_members_channel_joined_idx" ON "channel_members" USING btree ("channel_id","joined_at","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_org_name_uq" ON "channels" USING btree ("org_id",lower("name")) WHERE "channels"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "channels_purge_idx" ON "channels" USING btree ("deleted_at") WHERE "channels"."deleted_at" is not null;