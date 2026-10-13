CREATE TABLE "organization_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invites_role_ck" CHECK ("organization_invites"."role" in ('admin', 'member')),
	CONSTRAINT "organization_invites_token_hash_length_ck" CHECK (octet_length("organization_invites"."token_hash") = 32),
	CONSTRAINT "organization_invites_max_uses_ck" CHECK ("organization_invites"."max_uses" is null or "organization_invites"."max_uses" > 0),
	CONSTRAINT "organization_invites_use_count_ck" CHECK ("organization_invites"."use_count" >= 0 and ("organization_invites"."max_uses" is null or "organization_invites"."use_count" <= "organization_invites"."max_uses"))
);
--> statement-breakpoint
CREATE TABLE "organization_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invite_id" uuid,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_join_requests_role_ck" CHECK ("organization_join_requests"."role" in ('admin', 'member')),
	CONSTRAINT "organization_join_requests_status_ck" CHECK ("organization_join_requests"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "organization_join_requests_decided_ck" CHECK (("organization_join_requests"."status" = 'pending') = ("organization_join_requests"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "require_join_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_invite_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."organization_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD CONSTRAINT "organization_join_requests_decided_by_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invites_token_hash_uq" ON "organization_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "organization_invites_org_created_idx" ON "organization_invites" USING btree ("org_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_join_requests_one_pending_uq" ON "organization_join_requests" USING btree ("org_id","user_id") WHERE "organization_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "organization_join_requests_org_status_idx" ON "organization_join_requests" USING btree ("org_id","status","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("org_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);