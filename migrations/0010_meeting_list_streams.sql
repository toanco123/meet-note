-- Sửa tay (M11 B5): drizzle-kit sinh `ADD COLUMN … NOT NULL` không default → hỏng trên DB đã có share.
-- Ba bước: thêm cột cho phép NULL → chép từ meetings → mới đặt NOT NULL.
ALTER TABLE "meeting_shares" ADD COLUMN "recorded_at" timestamp with time zone;--> statement-breakpoint
UPDATE "meeting_shares" SET "recorded_at" = "meetings"."recorded_at" FROM "meetings" WHERE "meetings"."id" = "meeting_shares"."meeting_id";--> statement-breakpoint
ALTER TABLE "meeting_shares" ALTER COLUMN "recorded_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "meeting_shares_channel_recorded_idx" ON "meeting_shares" USING btree ("channel_id","recorded_at" DESC NULLS FIRST,"meeting_id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "meetings_org_owner_recorded_idx" ON "meetings" USING btree ("org_id","owner_id","recorded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "meetings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "meetings_org_ownerless_recorded_idx" ON "meetings" USING btree ("org_id","recorded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "meetings"."owner_id" is null and "meetings"."deleted_at" is null;