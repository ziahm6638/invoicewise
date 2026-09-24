CREATE TYPE "public"."inbox_intake_state" AS ENUM('reserved', 'accepted', 'cancelled');--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "intake_state" "public"."inbox_intake_state";--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "intake_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_team_content_hash_intake_idx" ON "inbox" USING btree ("team_id","content_hash") WHERE "intake_state" in ('reserved'::"public"."inbox_intake_state", 'accepted'::"public"."inbox_intake_state");
