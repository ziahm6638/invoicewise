CREATE TABLE "invoice_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"match_id" uuid NOT NULL,
	"processing_revision" integer NOT NULL,
	"status" text NOT NULL,
	"consumes" boolean NOT NULL,
	"result" jsonb NOT NULL,
	"rules_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_reconciliations_status_check" CHECK ("status" IN ('reconciled', 'discrepancy', 'unresolved', 'unmatched'))
);
--> statement-breakpoint
ALTER TABLE "invoice_reconciliations" ADD CONSTRAINT "invoice_reconciliations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reconciliations" ADD CONSTRAINT "invoice_reconciliations_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reconciliations" ADD CONSTRAINT "invoice_reconciliations_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."invoice_source_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_reconciliations_inbox_sequence_key" ON "invoice_reconciliations" USING btree ("inbox_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_reconciliations_match_revision_key" ON "invoice_reconciliations" USING btree ("inbox_id","match_id","processing_revision");--> statement-breakpoint
CREATE INDEX "invoice_reconciliations_team_id_idx" ON "invoice_reconciliations" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "invoice_source_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_reference" text,
	"amount" numeric(16, 2),
	"quantity" numeric(20, 4),
	"currency" text,
	"basis" text NOT NULL,
	CONSTRAINT "invoice_source_consumption_basis_check" CHECK ("basis" IN ('net', 'gross'))
);
--> statement-breakpoint
ALTER TABLE "invoice_source_consumption" ADD CONSTRAINT "invoice_source_consumption_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_consumption" ADD CONSTRAINT "invoice_source_consumption_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."invoice_reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_consumption" ADD CONSTRAINT "invoice_source_consumption_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_consumption" ADD CONSTRAINT "invoice_source_consumption_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."authorization_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_source_consumption_team_source_idx" ON "invoice_source_consumption" USING btree ("team_id","source_id");--> statement-breakpoint
CREATE INDEX "invoice_source_consumption_reconciliation_idx" ON "invoice_source_consumption" USING btree ("reconciliation_id");--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "reconciliation_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_reconciliation_id_invoice_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."invoice_reconciliations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_decisions" ADD COLUMN "deferred" jsonb;--> statement-breakpoint
CREATE TRIGGER "invoice_reconciliations_immutable" BEFORE UPDATE ON "invoice_reconciliations" FOR EACH ROW EXECUTE FUNCTION "invoice_source_matches_immutable"();--> statement-breakpoint
CREATE TRIGGER "invoice_source_consumption_immutable" BEFORE UPDATE ON "invoice_source_consumption" FOR EACH ROW EXECUTE FUNCTION "invoice_source_matches_immutable"();
