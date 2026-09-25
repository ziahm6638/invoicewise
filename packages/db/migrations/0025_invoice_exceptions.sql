ALTER TABLE "inbox" ADD COLUMN "extraction_original" jsonb;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "judgments_rerun_status" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "judgments_rerun_error" text;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "judgments_rerun_revision" integer;--> statement-breakpoint
CREATE TABLE "invoice_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" uuid,
	"reason" text NOT NULL,
	"changes" jsonb NOT NULL,
	"extraction" jsonb NOT NULL,
	"accounting_outcome" text NOT NULL,
	"provider" "accounting_provider",
	"provider_id" text,
	"update_status" text,
	"update_error" text,
	"update_retryable" boolean,
	"updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_corrections" ADD CONSTRAINT "invoice_corrections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_corrections" ADD CONSTRAINT "invoice_corrections_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_corrections" ADD CONSTRAINT "invoice_corrections_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_corrections_invoice_version_key" ON "invoice_corrections" USING btree ("invoice_id","version");--> statement-breakpoint
CREATE INDEX "invoice_corrections_team_invoice_idx" ON "invoice_corrections" USING btree ("team_id","invoice_id");
