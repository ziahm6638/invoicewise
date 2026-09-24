ALTER TYPE "public"."accounting_post_status" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "accounting_post_released" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "accounting_post_claims" (
	"team_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_post_claims_pkey" PRIMARY KEY("team_id","identity_key")
);
--> statement-breakpoint
ALTER TABLE "accounting_post_claims" ADD CONSTRAINT "accounting_post_claims_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_post_claims" ADD CONSTRAINT "accounting_post_claims_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;