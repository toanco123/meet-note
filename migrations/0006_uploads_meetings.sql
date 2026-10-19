CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid,
	"title" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"language" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"source_object_key" text NOT NULL,
	"audio_object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "meetings_id_org_uq" UNIQUE("id","org_id"),
	CONSTRAINT "meetings_status_ck" CHECK ("meetings"."status" in ('queued', 'preprocessing', 'transcribing', 'summarizing', 'completed', 'failed')),
	CONSTRAINT "meetings_title_length_ck" CHECK (char_length("meetings"."title") between 1 and 200),
	CONSTRAINT "meetings_attempt_ck" CHECK ("meetings"."attempt" >= 1),
	CONSTRAINT "meetings_duration_ck" CHECK ("meetings"."duration_ms" is null or "meetings"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_parts_pk" PRIMARY KEY("upload_id","part_number"),
	CONSTRAINT "upload_parts_number_ck" CHECK ("upload_parts"."part_number" between 1 and 10000),
	CONSTRAINT "upload_parts_size_ck" CHECK ("upload_parts"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"chunk_size" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"title" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"object_key" text NOT NULL,
	"s3_upload_id" text NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"meeting_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"storage_aborted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uploads_status_ck" CHECK ("uploads"."status" in ('initiated', 'completed', 'aborted', 'expired')),
	CONSTRAINT "uploads_mime_type_ck" CHECK ("uploads"."mime_type" in ('audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac', 'video/mp4', 'video/webm')),
	CONSTRAINT "uploads_size_ck" CHECK ("uploads"."size_bytes" between 1 and 2147483648),
	CONSTRAINT "uploads_sha256_ck" CHECK ("uploads"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "uploads_chunk_size_ck" CHECK ("uploads"."chunk_size" >= 5242880),
	CONSTRAINT "uploads_total_parts_ck" CHECK ("uploads"."total_parts" = ("uploads"."size_bytes" + "uploads"."chunk_size" - 1) / "uploads"."chunk_size" and "uploads"."total_parts" <= 10000),
	CONSTRAINT "uploads_filename_length_ck" CHECK (char_length("uploads"."filename") between 1 and 255),
	CONSTRAINT "uploads_title_length_ck" CHECK (char_length("uploads"."title") between 1 and 200),
	CONSTRAINT "uploads_completed_ck" CHECK (("uploads"."status" = 'completed') = ("uploads"."meeting_id" is not null and "uploads"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "idempotency_keys_status_ck" CHECK ("idempotency_keys"."status" in ('processing', 'completed')),
	CONSTRAINT "idempotency_keys_key_length_ck" CHECK (char_length("idempotency_keys"."key") between 1 and 255),
	CONSTRAINT "idempotency_keys_completed_ck" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."response_status" is not null))
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_meeting_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_org_owner_created_idx" ON "meetings" USING btree ("org_id","owner_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "meetings_org_recorded_idx" ON "meetings" USING btree ("org_id","recorded_at");--> statement-breakpoint
CREATE INDEX "uploads_expiry_idx" ON "uploads" USING btree ("expires_at") WHERE "uploads"."status" = 'initiated';--> statement-breakpoint
CREATE INDEX "uploads_abort_retry_idx" ON "uploads" USING btree ("id") WHERE "uploads"."status" in ('aborted', 'expired') and "uploads"."storage_aborted_at" is null;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");