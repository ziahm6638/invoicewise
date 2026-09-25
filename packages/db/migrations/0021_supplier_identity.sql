CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"vat_key" text,
	"company_key" text,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suppliers_team_name_key_idx" ON "suppliers" USING btree ("team_id","name_key");--> statement-breakpoint
CREATE INDEX "suppliers_merged_into_id_idx" ON "suppliers" USING btree ("merged_into_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_team_vat_key_key" ON "suppliers" USING btree ("team_id","vat_key") WHERE "suppliers"."vat_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_team_company_key_key" ON "suppliers" USING btree ("team_id","company_key") WHERE "suppliers"."company_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "supplier_resolution" jsonb;--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "supplier_checks" jsonb;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_team_supplier_created_at_idx" ON "inbox" USING btree ("team_id","supplier_id","created_at") WHERE "inbox"."supplier_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "supplier_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"action" text NOT NULL,
	"supplier_id" uuid,
	"target_supplier_id" uuid,
	"inbox_id" uuid,
	"actor_id" uuid,
	"data" jsonb NOT NULL,
	"reverts_event_id" uuid,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_events_team_created_at_idx" ON "supplier_events" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE TABLE "inbox_redeliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"reference_id" text,
	"inbox_account_id" uuid,
	"file_name" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_redeliveries" ADD CONSTRAINT "inbox_redeliveries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_redeliveries" ADD CONSTRAINT "inbox_redeliveries_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_redeliveries_inbox_id_idx" ON "inbox_redeliveries" USING btree ("inbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_redeliveries_team_reference_id_key" ON "inbox_redeliveries" USING btree ("team_id","reference_id") WHERE "inbox_redeliveries"."reference_id" IS NOT NULL;
