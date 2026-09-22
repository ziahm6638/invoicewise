CREATE TYPE "public"."invoice_question_type" AS ENUM('boolean', 'choice', 'score');--> statement-breakpoint
CREATE TABLE "user_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_key" text NOT NULL,
	"team_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"label" text NOT NULL,
	"question" text NOT NULL,
	"type" "invoice_question_type" NOT NULL,
	"options" jsonb,
	"context" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_questions_team_key_version_key" UNIQUE("team_id","question_key","version")
);
--> statement-breakpoint
ALTER TABLE "user_questions" ADD CONSTRAINT "user_questions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_questions" ADD CONSTRAINT "user_questions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_questions_team_id_idx" ON "user_questions" USING btree ("team_id");--> statement-breakpoint
INSERT INTO "user_questions" (
	"question_key", "team_id", "version", "label", "question", "type", "context", "enabled", "is_default"
)
SELECT defaults."question_key", teams."id", 1, defaults."label", defaults."question", 'boolean'::"invoice_question_type", defaults."context", true, true
FROM "teams"
CROSS JOIN (
	VALUES
		('likely_duplicate', 'Likely duplicate', 'Is `currentInvoice` likely a duplicate of any entry in `previousInvoices`?', 'Answer yes when the supplier and invoice number match, or when supplier, date, and gross amount strongly indicate the same invoice.'),
		('vat_calculation_correct', 'VAT calculation correct', 'Is the VAT calculation on `currentInvoice` arithmetically correct, so net amount plus VAT amount equals gross amount?', 'Allow normal currency rounding. Answer no when the amounts are missing or do not reconcile.'),
		('known_supplier', 'Known supplier', 'Does `currentInvoice.supplierName` identify a supplier present in `previousInvoices`?', 'Allow ordinary legal-name variations. Answer no when no previous invoice is from this supplier.'),
		('bank_details_consistent', 'Bank details consistent', 'Are `currentInvoice.bankDetails` consistent with bank details on previous invoices from the same supplier?', 'Answer no when material bank identifiers differ, are absent, or no prior bank detail exists for this supplier.')
) AS defaults("question_key", "label", "question", "context");
