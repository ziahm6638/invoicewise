CREATE TYPE "public"."inbound_email_status" AS ENUM('received', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE "inbound_email_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "inbound_email_addresses_local_part_key" UNIQUE("local_part")
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"address_id" uuid,
	"recipient" text NOT NULL,
	"envelope_from" text,
	"message_key" text NOT NULL,
	"message_id" text,
	"header_from" text,
	"subject" text,
	"sent_at" text,
	"authentication_results" text,
	"size" integer NOT NULL,
	"raw_sha256" text NOT NULL,
	"raw" bytea,
	"status" "inbound_email_status" DEFAULT 'received' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" text,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"last_delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_emails_team_message_key" UNIQUE("team_id","message_key")
);
--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "inbound_email_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_email_addresses" ADD CONSTRAINT "inbound_email_addresses_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_email_addresses" ADD CONSTRAINT "inbound_email_addresses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "public"."inbound_email_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_email_addresses_active_team_key" ON "inbound_email_addresses" USING btree ("team_id") WHERE "inbound_email_addresses"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "inbound_emails_team_created_at_idx" ON "inbound_emails" USING btree ("team_id","created_at");--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_inbound_email_id_fkey" FOREIGN KEY ("inbound_email_id") REFERENCES "public"."inbound_emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_inbound_email_id_idx" ON "inbox" USING btree ("inbound_email_id");