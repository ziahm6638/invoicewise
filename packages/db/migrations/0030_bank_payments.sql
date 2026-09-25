CREATE TABLE "bank_payment_settings" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'saltedge' NOT NULL,
	"provider_customer_id" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_payment_settings_provider_check" CHECK ("provider" IN ('saltedge'))
);
--> statement-breakpoint
ALTER TABLE "bank_payment_settings" ADD CONSTRAINT "bank_payment_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_payment_settings" ADD CONSTRAINT "bank_payment_settings_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_payment_settings_customer_key" ON "bank_payment_settings" USING btree ("provider","provider_customer_id") WHERE "provider_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "bank_feed_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" text DEFAULT 'saltedge' NOT NULL,
	"provider_connection_id" text,
	"provider_name" text,
	"status" text NOT NULL,
	"consent_status" text NOT NULL,
	"consent_id" text,
	"consent_period_days" integer NOT NULL,
	"consent_given_by" uuid,
	"consent_given_at" timestamp with time zone NOT NULL,
	"consent_expires_at" timestamp with time zone,
	"attempt_started_at" timestamp with time zone,
	"last_error_class" text,
	"last_error" text,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_finished_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"last_sync_summary" jsonb,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"disconnected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_feed_connections_provider_check" CHECK ("provider" IN ('saltedge')),
	CONSTRAINT "bank_feed_connections_status_check" CHECK ("status" IN ('pending', 'active', 'reconnect_required', 'failed', 'disconnected')),
	CONSTRAINT "bank_feed_connections_consent_status_check" CHECK ("consent_status" IN ('pending', 'active', 'expired', 'revoked', 'withdrawn')),
	CONSTRAINT "bank_feed_connections_sync_status_check" CHECK ("last_sync_status" IS NULL OR "last_sync_status" IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "bank_feed_connections" ADD CONSTRAINT "bank_feed_connections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_connections" ADD CONSTRAINT "bank_feed_connections_consent_given_by_fkey" FOREIGN KEY ("consent_given_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_connections" ADD CONSTRAINT "bank_feed_connections_disconnected_by_fkey" FOREIGN KEY ("disconnected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_connections_provider_key" ON "bank_feed_connections" USING btree ("provider","provider_connection_id") WHERE "provider_connection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bank_feed_connections_team_id_idx" ON "bank_feed_connections" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "bank_feed_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"name" text NOT NULL,
	"nature" text,
	"currency" text NOT NULL,
	"posted_cursor" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_accounts" ADD CONSTRAINT "bank_feed_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_feed_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_accounts_connection_account_key" ON "bank_feed_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE INDEX "bank_feed_accounts_team_id_idx" ON "bank_feed_accounts" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "bank_feed_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"status" text NOT NULL,
	"duplicated" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'normal' NOT NULL,
	"made_on" date NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"counterparty" text,
	"reference" text,
	"fingerprint" text NOT NULL,
	"superseded_by_id" uuid,
	"reversed_by_id" uuid,
	"reversal" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_feed_transactions_status_check" CHECK ("status" IN ('pending', 'posted', 'superseded', 'reversed')),
	CONSTRAINT "bank_feed_transactions_mode_check" CHECK ("mode" IN ('normal', 'fee', 'transfer'))
);
--> statement-breakpoint
ALTER TABLE "bank_feed_transactions" ADD CONSTRAINT "bank_feed_transactions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_transactions" ADD CONSTRAINT "bank_feed_transactions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_feed_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_transactions" ADD CONSTRAINT "bank_feed_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."bank_feed_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_transactions" ADD CONSTRAINT "bank_feed_transactions_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."bank_feed_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_feed_transactions" ADD CONSTRAINT "bank_feed_transactions_reversed_by_id_fkey" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."bank_feed_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_feed_transactions_account_provider_key" ON "bank_feed_transactions" USING btree ("account_id","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "bank_feed_transactions_team_currency_idx" ON "bank_feed_transactions" USING btree ("team_id","currency","made_on");--> statement-breakpoint
CREATE TABLE "invoice_payment_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"payment_status" text NOT NULL,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"currency" text,
	"due_amount" numeric(16, 2),
	"paid_amount" numeric(16, 2) NOT NULL,
	"result" jsonb NOT NULL,
	"reason" text,
	"processing_revision" integer,
	"rules_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payment_matches_status_check" CHECK ("status" IN ('matched', 'pending', 'proposed', 'ambiguous', 'unmatched', 'insufficient_evidence')),
	CONSTRAINT "invoice_payment_matches_payment_status_check" CHECK ("payment_status" IN ('unpaid', 'pending', 'partially_paid', 'paid', 'overpaid', 'applied')),
	CONSTRAINT "invoice_payment_matches_origin_check" CHECK ("origin" IN ('automatic', 'manual')),
	CONSTRAINT "invoice_payment_matches_action_check" CHECK ("action" IN ('automatic', 'reversal', 'confirm', 'correct', 'unlink'))
);
--> statement-breakpoint
ALTER TABLE "invoice_payment_matches" ADD CONSTRAINT "invoice_payment_matches_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_matches" ADD CONSTRAINT "invoice_payment_matches_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_matches" ADD CONSTRAINT "invoice_payment_matches_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payment_matches_inbox_sequence_key" ON "invoice_payment_matches" USING btree ("inbox_id","sequence");--> statement-breakpoint
CREATE INDEX "invoice_payment_matches_team_id_idx" ON "invoice_payment_matches" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "invoice_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"transaction_id" uuid,
	"credit_inbox_id" uuid,
	"amount" numeric(16, 2) NOT NULL,
	"currency" text NOT NULL,
	CONSTRAINT "invoice_payment_allocations_kind_check" CHECK ("kind" IN ('payment', 'fee', 'credit')),
	CONSTRAINT "invoice_payment_allocations_target_check" CHECK (
		("kind" = 'credit' AND "credit_inbox_id" IS NOT NULL AND "transaction_id" IS NULL)
		OR ("kind" <> 'credit' AND "transaction_id" IS NOT NULL AND "credit_inbox_id" IS NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "invoice_payment_allocations" ADD CONSTRAINT "invoice_payment_allocations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_allocations" ADD CONSTRAINT "invoice_payment_allocations_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "public"."invoice_payment_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_allocations" ADD CONSTRAINT "invoice_payment_allocations_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_allocations" ADD CONSTRAINT "invoice_payment_allocations_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_feed_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payment_allocations" ADD CONSTRAINT "invoice_payment_allocations_credit_inbox_id_fkey" FOREIGN KEY ("credit_inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_payment_allocations_match_id_idx" ON "invoice_payment_allocations" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "invoice_payment_allocations_transaction_id_idx" ON "invoice_payment_allocations" USING btree ("transaction_id");--> statement-breakpoint
ALTER TABLE "inbox" ADD COLUMN "payment_match_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_payment_match_id_invoice_payment_matches_id_fk" FOREIGN KEY ("payment_match_id") REFERENCES "public"."invoice_payment_matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "invoice_payment_matches_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Only the actor is cleared when a user is deleted; a recorded payment
	-- decision and its allocations never change. Record a new decision instead.
	IF (to_jsonb(NEW) - 'actor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_id') THEN
		RAISE EXCEPTION 'invoice payment decisions are immutable; record a new decision instead';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "invoice_payment_matches_immutable" BEFORE UPDATE ON "invoice_payment_matches" FOR EACH ROW EXECUTE FUNCTION "invoice_payment_matches_immutable"();--> statement-breakpoint
CREATE TRIGGER "invoice_payment_allocations_immutable" BEFORE UPDATE ON "invoice_payment_allocations" FOR EACH ROW EXECUTE FUNCTION "invoice_payment_matches_immutable"();
