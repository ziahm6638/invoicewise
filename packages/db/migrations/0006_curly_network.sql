CREATE TYPE "public"."accounting_post_status" AS ENUM('posted', 'already_posted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."accounting_provider" AS ENUM('xero', 'quickbooks');--> statement-breakpoint
CREATE TABLE "accounting_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" "accounting_provider" NOT NULL,
	"integration_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"capabilities" text[] DEFAULT ARRAY['draft_bills']::text[] NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_connections_team_provider_key" UNIQUE("team_id","provider")
);
--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_provider" "accounting_provider";--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_post_status" "accounting_post_status";--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_provider_id" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_post_error" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_connections_team_id_idx" ON "accounting_connections" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_connections_one_active_per_team_key" ON "accounting_connections" USING btree ("team_id") WHERE "accounting_connections"."disconnected_at" IS NULL;