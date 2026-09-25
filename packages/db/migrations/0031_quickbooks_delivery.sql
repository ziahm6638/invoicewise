ALTER TABLE "accounting_connections" ADD COLUMN "organisation_id" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "organisation_name" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "auto_post_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "auto_post_enabled_by" uuid;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "health_status" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "health_error" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_auto_post_enabled_by_fkey" FOREIGN KEY ("auto_post_enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_health_status_check" CHECK ("health_status" IN ('ok', 'reconnect', 'unavailable'));--> statement-breakpoint
-- Xero connections posted draft bills automatically before the opt-in
-- existed; they keep doing so. QuickBooks creates open bills, so any
-- existing QuickBooks connection waits for an admin to opt in.
UPDATE "accounting_connections" SET "auto_post_enabled_at" = "connected_at" WHERE "provider" = 'xero';--> statement-breakpoint
UPDATE "accounting_connections" SET "capabilities" = ARRAY['open_bills', 'vendor_credits']::text[] WHERE "provider" = 'quickbooks';--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_provider_entity" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_attachment_status" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_attachment_error" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_accounting_provider_entity_check" CHECK ("accounting_provider_entity" IN ('bill', 'vendor_credit'));--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_accounting_attachment_status_check" CHECK ("accounting_attachment_status" IN ('attached', 'queued', 'failed'));--> statement-breakpoint
UPDATE "inbox" SET "accounting_provider_entity" = 'bill' WHERE "accounting_provider_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_organisation_id" text;--> statement-breakpoint
UPDATE "inbox" SET "accounting_organisation_id" = "accounting_connections"."organisation_id" FROM "accounting_connections" WHERE "inbox"."accounting_provider_id" IS NOT NULL AND "accounting_connections"."team_id" = "inbox"."team_id" AND "accounting_connections"."provider" = "inbox"."accounting_provider";
