CREATE TABLE "org_daily_stats" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"meetings_total" integer DEFAULT 0 NOT NULL,
	"meetings_completed" integer DEFAULT 0 NOT NULL,
	"meetings_failed" integer DEFAULT 0 NOT NULL,
	"recorded_ms" bigint DEFAULT 0 NOT NULL,
	"transcribed_ms" bigint DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_daily_stats_pk" PRIMARY KEY("org_id","day"),
	CONSTRAINT "org_daily_stats_counts_ck" CHECK ("org_daily_stats"."meetings_total" >= 0 and "org_daily_stats"."meetings_completed" >= 0 and "org_daily_stats"."meetings_failed" >= 0
        and "org_daily_stats"."meetings_completed" + "org_daily_stats"."meetings_failed" <= "org_daily_stats"."meetings_total"),
	CONSTRAINT "org_daily_stats_ms_ck" CHECK ("org_daily_stats"."recorded_ms" >= 0 and "org_daily_stats"."transcribed_ms" >= 0 and "org_daily_stats"."transcribed_ms" <= "org_daily_stats"."recorded_ms")
);
--> statement-breakpoint
ALTER TABLE "org_daily_stats" ADD CONSTRAINT "org_daily_stats_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Viết tay (M17 Q9): RLS ranh giới tổ chức, cùng mẫu 0012 / 0013 / 0015 / 0018. Worker (BYPASSRLS)
-- tính lại và ghi; api chỉ đọc dòng của tổ chức trong ngữ cảnh `app.org_id`.
ALTER TABLE org_daily_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_daily_stats FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY org_daily_stats_org_isolation ON org_daily_stats
  USING (org_id = app_current_org_id()) WITH CHECK (org_id = app_current_org_id());
