ALTER TABLE "inbox" DROP CONSTRAINT "inbox_reference_id_key";--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_team_reference_id_key" ON "inbox" USING btree ("team_id","reference_id") WHERE "reference_id" IS NOT NULL;
