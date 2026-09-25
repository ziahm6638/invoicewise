CREATE TABLE "invoice_source_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"method" text,
	"result" jsonb NOT NULL,
	"reason" text,
	"processing_revision" integer,
	"rules_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_source_matches_status_check" CHECK ("status" IN ('matched', 'unmatched', 'ambiguous', 'insufficient_evidence')),
	CONSTRAINT "invoice_source_matches_origin_check" CHECK ("origin" IN ('automatic', 'manual')),
	CONSTRAINT "invoice_source_matches_action_check" CHECK ("action" IN ('automatic', 'confirm', 'correct', 'unlink'))
);
--> statement-breakpoint
ALTER TABLE "invoice_source_matches" ADD CONSTRAINT "invoice_source_matches_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_matches" ADD CONSTRAINT "invoice_source_matches_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_matches" ADD CONSTRAINT "invoice_source_matches_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_source_matches_inbox_sequence_key" ON "invoice_source_matches" USING btree ("inbox_id","sequence");--> statement-breakpoint
CREATE INDEX "invoice_source_matches_team_id_idx" ON "invoice_source_matches" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "invoice_source_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."invoice_source_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."authorization_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."authorization_source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_source_links_match_source_key" ON "invoice_source_links" USING btree ("match_id","source_id");--> statement-breakpoint
CREATE INDEX "invoice_source_links_team_source_idx" ON "invoice_source_links" USING btree ("team_id","source_id");--> statement-breakpoint
CREATE TABLE "invoice_source_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"source_line_reference" text,
	"invoice_line_index" integer,
	"amount" numeric(16, 2),
	"currency" text,
	"basis" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_allocations" ADD CONSTRAINT "invoice_source_allocations_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "public"."invoice_source_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_source_allocations_link_id_idx" ON "invoice_source_allocations" USING btree ("link_id");--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "source_match_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_source_match_id_invoice_source_matches_id_fk" FOREIGN KEY ("source_match_id") REFERENCES "public"."invoice_source_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "invoice_source_matches_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Only the actor is cleared when a user is deleted; a recorded decision,
	-- its links and its allocations never change. Record a new decision instead.
	IF (to_jsonb(NEW) - 'actor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_id') THEN
		RAISE EXCEPTION 'invoice source match decisions are immutable; record a new decision instead';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "invoice_source_matches_immutable" BEFORE UPDATE ON "invoice_source_matches" FOR EACH ROW EXECUTE FUNCTION "invoice_source_matches_immutable"();--> statement-breakpoint
CREATE TRIGGER "invoice_source_links_immutable" BEFORE UPDATE ON "invoice_source_links" FOR EACH ROW EXECUTE FUNCTION "invoice_source_matches_immutable"();--> statement-breakpoint
CREATE TRIGGER "invoice_source_allocations_immutable" BEFORE UPDATE ON "invoice_source_allocations" FOR EACH ROW EXECUTE FUNCTION "invoice_source_matches_immutable"();
