ALTER TYPE "public"."accounting_post_status" ADD VALUE 'queued';--> statement-breakpoint
ALTER TYPE "public"."accounting_post_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."webhook_delivery_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_post_retryable" boolean;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_revision" integer;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "processing_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "retryable" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_key" ON "webhook_deliveries" USING btree ("endpoint_id","event_id") WHERE "webhook_deliveries"."event_id" is not null;--> statement-breakpoint
-- Deliveries recorded before revisions existed belong to the original
-- processing of their invoice, which is revision 0.
UPDATE "webhook_deliveries" SET "revision" = 0 WHERE "invoice_id" IS NOT NULL;
