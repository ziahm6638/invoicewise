CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS auth;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS private;--> statement-breakpoint
DO $$
BEGIN
	CREATE ROLE authenticated NOLOGIN;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$ SELECT '{}'::jsonb $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$ SELECT NULL::uuid $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.get_teams_for_authenticated_user()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
AS $$ SELECT NULL::uuid WHERE false $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION extract_product_names(products json)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT COALESCE(string_agg(product ->> 'name', ' '), '')
	FROM json_array_elements(COALESCE(products, '[]'::json)) AS product
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION generate_inbox_fts(display_name text, product_names text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
AS $$
	SELECT to_tsvector(
		'english'::regconfig,
		COALESCE(display_name, '') || ' ' || COALESCE(product_names, '')
	)
$$;--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('depository', 'credit', 'other_asset', 'loan', 'other_liability');--> statement-breakpoint
CREATE TYPE "public"."activity_source" AS ENUM('system', 'user');--> statement-breakpoint
CREATE TYPE "public"."activity_status" AS ENUM('unread', 'read', 'archived');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('transactions_enriched', 'transactions_created', 'invoice_paid', 'inbox_new', 'inbox_auto_matched', 'inbox_needs_review', 'inbox_cross_currency_matched', 'invoice_overdue', 'invoice_sent', 'inbox_match_confirmed', 'document_uploaded', 'document_processed', 'invoice_duplicated', 'invoice_scheduled', 'invoice_reminder_sent', 'invoice_cancelled', 'invoice_created', 'draft_invoice_created', 'tracker_entry_created', 'tracker_project_created', 'transactions_categorized', 'transactions_assigned', 'transaction_attachment_created', 'transaction_category_created', 'transactions_exported', 'customer_created');--> statement-breakpoint
CREATE TYPE "public"."bank_providers" AS ENUM('gocardless', 'plaid', 'teller', 'enablebanking');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('disconnected', 'connected', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."document_processing_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbox_account_providers" AS ENUM('gmail', 'outlook');--> statement-breakpoint
CREATE TYPE "public"."inbox_account_status" AS ENUM('connected', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('processing', 'pending', 'archived', 'new', 'analyzing', 'suggested_match', 'no_match', 'done', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."inbox_type" AS ENUM('invoice', 'expense');--> statement-breakpoint
CREATE TYPE "public"."invoice_delivery_type" AS ENUM('create', 'create_and_send', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."invoice_size" AS ENUM('a4', 'letter');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'overdue', 'paid', 'unpaid', 'canceled', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."plans" AS ENUM('trial', 'starter', 'pro');--> statement-breakpoint
CREATE TYPE "public"."reportTypes" AS ENUM('profit', 'revenue', 'burn_rate', 'expense');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'canceled', 'past_due', 'unpaid', 'trialing', 'incomplete', 'incomplete_expired');--> statement-breakpoint
CREATE TYPE "public"."teamRoles" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."trackerStatus" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."transaction_frequency" AS ENUM('weekly', 'biweekly', 'monthly', 'semi_monthly', 'annually', 'irregular', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."transactionMethods" AS ENUM('payment', 'card_purchase', 'card_atm', 'transfer', 'other', 'unknown', 'ach', 'interest', 'deposit', 'wire', 'fee');--> statement-breakpoint
CREATE TYPE "public"."transactionStatus" AS ENUM('posted', 'pending', 'excluded', 'completed', 'archived');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"type" "activity_type" NOT NULL,
	"priority" smallint DEFAULT 5,
	"group_id" uuid,
	"source" "activity_source" NOT NULL,
	"metadata" jsonb NOT NULL,
	"status" "activity_status" DEFAULT 'unread' NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_encrypted" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"key_hash" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid DEFAULT gen_random_uuid(),
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"app_id" text NOT NULL,
	"created_by" uuid DEFAULT gen_random_uuid(),
	"settings" jsonb,
	CONSTRAINT "unique_app_id_team_id" UNIQUE("team_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text,
	"currency" text,
	"bank_connection_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_id" text NOT NULL,
	"balance" numeric(10, 2) DEFAULT 0,
	"manual" boolean DEFAULT false,
	"type" "account_type",
	"base_currency" text,
	"base_balance" numeric(10, 2),
	"error_details" text,
	"error_retries" smallint,
	"account_reference" text
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"institution_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"access_token" text,
	"enrollment_id" text,
	"provider" "bank_providers" NOT NULL,
	"last_accessed" timestamp with time zone,
	"reference_id" text,
	"status" "connection_status" DEFAULT 'connected',
	"error_details" text,
	"error_retries" smallint DEFAULT '0',
	CONSTRAINT "unique_bank_connections" UNIQUE("institution_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "bank_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "unique_customer_tag" UNIQUE("customer_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "customer_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"billing_email" text,
	"country" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"state" text,
	"zip" text,
	"note" text,
	"team_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"website" text,
	"phone" text,
	"vat_number" text,
	"country_code" text,
	"token" text DEFAULT '' NOT NULL,
	"contact" text,
	"fts" "tsvector" GENERATED ALWAYS AS (
				to_tsvector(
					'english'::regconfig,
					COALESCE(name, ''::text) || ' ' ||
					COALESCE(contact, ''::text) || ' ' ||
					COALESCE(phone, ''::text) || ' ' ||
					COALESCE(email, ''::text) || ' ' ||
					COALESCE(address_line_1, ''::text) || ' ' ||
					COALESCE(address_line_2, ''::text) || ' ' ||
					COALESCE(city, ''::text) || ' ' ||
					COALESCE(state, ''::text) || ' ' ||
					COALESCE(zip, ''::text) || ' ' ||
					COALESCE(country, ''::text)
				)
			) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_tag_assignments" (
	"document_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "document_tag_assignments_pkey" PRIMARY KEY("document_id","tag_id"),
	CONSTRAINT "document_tag_assignments_unique" UNIQUE("document_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "document_tag_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_tag_embeddings" (
	"slug" text PRIMARY KEY NOT NULL,
	"embedding" vector(768),
	"name" text NOT NULL,
	"model" text DEFAULT 'gemini-embedding-001' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_tag_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "unique_slug_per_team" UNIQUE("slug","team_id")
);
--> statement-breakpoint
ALTER TABLE "document_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"metadata" jsonb,
	"path_tokens" text[],
	"team_id" uuid,
	"parent_id" text,
	"object_id" uuid,
	"owner_id" uuid,
	"tag" text,
	"title" text,
	"body" text,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((title || ' '::text) || body))) STORED NOT NULL,
	"summary" text,
	"content" text,
	"date" date,
	"language" text,
	"processing_status" "document_processing_status" DEFAULT 'pending',
	"fts_simple" "tsvector",
	"fts_english" "tsvector",
	"fts_language" "tsvector"
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" text,
	"rate" numeric(10, 2),
	"target" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "unique_rate" UNIQUE("base","target")
);
--> statement-breakpoint
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid,
	"file_path" text[],
	"file_name" text,
	"transaction_id" uuid,
	"amount" numeric(10, 2),
	"currency" text,
	"content_type" text,
	"size" bigint,
	"attachment_id" uuid,
	"date" date,
	"forwarded_to" text,
	"reference_id" text,
	"meta" json,
	"status" "inbox_status" DEFAULT 'new',
	"website" text,
	"display_name" text,
	"fts" "tsvector" GENERATED ALWAYS AS (generate_inbox_fts(display_name, extract_product_names((meta -> 'products'::text)))) STORED NOT NULL,
	"type" "inbox_type",
	"description" text,
	"base_amount" numeric(10, 2),
	"base_currency" text,
	"tax_amount" numeric(10, 2),
	"tax_rate" numeric(10, 2),
	"tax_type" text,
	"inbox_account_id" uuid,
	CONSTRAINT "inbox_reference_id_key" UNIQUE("reference_id")
);
--> statement-breakpoint
ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbox_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"team_id" uuid NOT NULL,
	"last_accessed" timestamp with time zone NOT NULL,
	"provider" "inbox_account_providers" NOT NULL,
	"external_id" text NOT NULL,
	"expiry_date" timestamp with time zone NOT NULL,
	"schedule_id" text,
	"status" "inbox_account_status" DEFAULT 'connected' NOT NULL,
	"error_message" text,
	CONSTRAINT "inbox_accounts_email_key" UNIQUE("email"),
	CONSTRAINT "inbox_accounts_external_id_key" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbox_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"embedding" vector(768),
	"source_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text DEFAULT 'gemini-embedding-001' NOT NULL,
	CONSTRAINT "inbox_embeddings_unique" UNIQUE("inbox_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"team_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"description" text,
	"price" numeric(10, 2),
	"currency" text,
	"unit" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"fts" "tsvector" GENERATED ALWAYS AS (
          to_tsvector(
            'english',
            (
              (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
            )
          )
        ) STORED NOT NULL,
	CONSTRAINT "invoice_products_team_name_currency_price_unique" UNIQUE("team_id","name","currency","price")
);
--> statement-breakpoint
ALTER TABLE "invoice_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"customer_label" text,
	"from_label" text,
	"invoice_no_label" text,
	"issue_date_label" text,
	"due_date_label" text,
	"description_label" text,
	"price_label" text,
	"quantity_label" text,
	"total_label" text,
	"vat_label" text,
	"tax_label" text,
	"payment_label" text,
	"note_label" text,
	"logo_url" text,
	"currency" text,
	"payment_details" jsonb,
	"from_details" jsonb,
	"note_details" jsonb,
	"size" "invoice_size" DEFAULT 'a4',
	"date_format" text,
	"include_vat" boolean,
	"include_tax" boolean,
	"tax_rate" numeric(10, 2),
	"delivery_type" "invoice_delivery_type" DEFAULT 'create' NOT NULL,
	"discount_label" text,
	"include_discount" boolean,
	"include_decimals" boolean,
	"include_qr" boolean,
	"total_summary_label" text,
	"title" text,
	"vat_rate" numeric(10, 2),
	"include_units" boolean,
	"subtotal_label" text,
	"include_pdf" boolean,
	"send_copy" boolean,
	CONSTRAINT "invoice_templates_team_id_key" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "invoice_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"due_date" timestamp with time zone,
	"invoice_number" text,
	"customer_id" uuid,
	"amount" numeric(10, 2),
	"currency" text,
	"line_items" jsonb,
	"payment_details" jsonb,
	"customer_details" jsonb,
	"company_datails" jsonb,
	"note" text,
	"internal_note" text,
	"team_id" uuid NOT NULL,
	"paid_at" timestamp with time zone,
	"fts" "tsvector" GENERATED ALWAYS AS (
        to_tsvector(
          'english',
          (
            (COALESCE((amount)::text, ''::text) || ' '::text) || COALESCE(invoice_number, ''::text)
          )
        )
      ) STORED NOT NULL,
	"vat" numeric(10, 2),
	"tax" numeric(10, 2),
	"url" text,
	"file_path" text[],
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"viewed_at" timestamp with time zone,
	"from_details" jsonb,
	"issue_date" timestamp with time zone,
	"template" jsonb,
	"note_details" jsonb,
	"customer_name" text,
	"token" text DEFAULT '' NOT NULL,
	"sent_to" text,
	"reminder_sent_at" timestamp with time zone,
	"discount" numeric(10, 2),
	"file_size" bigint,
	"user_id" uuid,
	"subtotal" numeric(10, 2),
	"top_block" jsonb,
	"bottom_block" jsonb,
	"sent_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"scheduled_job_id" text,
	CONSTRAINT "invoices_scheduled_job_id_key" UNIQUE("scheduled_job_id")
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"notification_type" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_user_team_type_channel_key" UNIQUE("user_id","team_id","notification_type","channel")
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"refresh_token" text,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked" boolean DEFAULT false,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "oauth_access_tokens_refresh_token_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE "oauth_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"overview" text,
	"developer_name" text,
	"logo_url" text,
	"website" text,
	"install_url" text,
	"screenshots" text[] DEFAULT '{}'::text[],
	"redirect_uris" text[] NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"team_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_public" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"status" text DEFAULT 'draft',
	CONSTRAINT "oauth_applications_slug_unique" UNIQUE("slug"),
	CONSTRAINT "oauth_applications_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used" boolean DEFAULT false,
	"code_challenge" text,
	"code_challenge_method" text,
	CONSTRAINT "oauth_authorization_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link_id" text,
	"team_id" uuid,
	"short_link" text,
	"from" timestamp with time zone,
	"to" timestamp with time zone,
	"type" "reportTypes",
	"expire_at" timestamp with time zone,
	"currency" text,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "short_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"url" text NOT NULL,
	"type" text,
	"size" numeric(10, 2),
	"mime_type" text,
	"file_name" text,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_links_short_id_unique" UNIQUE("short_id")
);
--> statement-breakpoint
ALTER TABLE "short_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "unique_tag_name" UNIQUE("team_id","name")
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"logo_url" text,
	"inbox_id" text DEFAULT 'generate_inbox(10)',
	"email" text,
	"inbox_email" text,
	"inbox_forwarding" boolean DEFAULT true,
	"base_currency" text,
	"country_code" text,
	"document_classification" boolean DEFAULT false,
	"flags" text[],
	"canceled_at" timestamp with time zone,
	"plan" "plans" DEFAULT 'trial' NOT NULL,
	"export_settings" jsonb,
	CONSTRAINT "teams_inbox_id_key" UNIQUE("inbox_id")
);
--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tracker_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration" bigint,
	"project_id" uuid,
	"start" timestamp with time zone,
	"stop" timestamp with time zone,
	"assigned_id" uuid,
	"team_id" uuid,
	"description" text,
	"rate" numeric(10, 2),
	"currency" text,
	"billed" boolean DEFAULT false,
	"date" date DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "tracker_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tracker_project_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tracker_project_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "unique_project_tag" UNIQUE("tracker_project_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "tracker_project_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tracker_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid,
	"rate" numeric(10, 2),
	"currency" text,
	"status" "trackerStatus" DEFAULT 'in_progress' NOT NULL,
	"description" text,
	"name" text NOT NULL,
	"billable" boolean DEFAULT false,
	"estimate" bigint,
	"customer_id" uuid,
	"fts" "tsvector" GENERATED ALWAYS AS (
          to_tsvector(
            'english'::regconfig,
            (
              (COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
            )
          )
        ) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracker_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tracker_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"link_id" text,
	"short_link" text,
	"team_id" uuid DEFAULT gen_random_uuid(),
	"project_id" uuid DEFAULT gen_random_uuid(),
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "tracker_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text,
	"transaction_id" uuid,
	"team_id" uuid,
	"size" bigint,
	"name" text,
	"path" text[]
);
--> statement-breakpoint
ALTER TABLE "transaction_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_categories" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"team_id" uuid NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"system" boolean DEFAULT false,
	"slug" text,
	"tax_rate" numeric(10, 2),
	"tax_type" text,
	"tax_reporting_code" text,
	"excluded" boolean DEFAULT false,
	"description" text,
	"parent_id" uuid,
	CONSTRAINT "transaction_categories_pkey" PRIMARY KEY("team_id","slug"),
	CONSTRAINT "transaction_categories_id_unique" UNIQUE("id"),
	CONSTRAINT "unique_team_slug" UNIQUE("team_id","slug")
);
--> statement-breakpoint
ALTER TABLE "transaction_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_category_embeddings" (
	"name" text PRIMARY KEY NOT NULL,
	"embedding" vector(768),
	"model" text DEFAULT 'gemini-embedding-001' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_category_embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"embedding" vector(768),
	"source_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text DEFAULT 'gemini-embedding-001' NOT NULL,
	CONSTRAINT "transaction_embeddings_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"team_id" uuid,
	"category_slug" text,
	"system" boolean DEFAULT false,
	CONSTRAINT "unique_team_name" UNIQUE("name","team_id")
);
--> statement-breakpoint
ALTER TABLE "transaction_enrichments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_match_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"confidence_score" numeric(4, 3) NOT NULL,
	"amount_score" numeric(4, 3),
	"currency_score" numeric(4, 3),
	"date_score" numeric(4, 3),
	"embedding_score" numeric(4, 3),
	"name_score" numeric(4, 3),
	"match_type" text NOT NULL,
	"match_details" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_action_at" timestamp with time zone,
	"user_id" uuid,
	CONSTRAINT "transaction_match_suggestions_unique" UNIQUE("inbox_id","transaction_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	CONSTRAINT "unique_tag" UNIQUE("tag_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "transaction_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"method" "transactionMethods" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"team_id" uuid NOT NULL,
	"assigned_id" uuid,
	"note" varchar,
	"bank_account_id" uuid,
	"internal_id" text NOT NULL,
	"status" "transactionStatus" DEFAULT 'posted',
	"balance" numeric(10, 2),
	"manual" boolean DEFAULT false,
	"notified" boolean DEFAULT false,
	"internal" boolean DEFAULT false,
	"description" text,
	"category_slug" text,
	"base_amount" numeric(10, 2),
	"counterparty_name" text,
	"base_currency" text,
	"tax_amount" numeric(10, 2),
	"tax_rate" numeric(10, 2),
	"tax_type" text,
	"recurring" boolean,
	"frequency" "transaction_frequency",
	"merchant_name" text,
	"enrichment_completed" boolean DEFAULT false,
	"fts_vector" "tsvector" GENERATED ALWAYS AS (
				to_tsvector(
					'english',
					(
						(COALESCE(name, ''::text) || ' '::text) || COALESCE(description, ''::text)
					)
				)
			) STORED NOT NULL,
	CONSTRAINT "transactions_internal_id_key" UNIQUE("internal_id")
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid,
	"email" text,
	"role" "teamRoles",
	"code" text DEFAULT 'nanoid(24)',
	"invited_by" uuid,
	CONSTRAINT "unique_team_invite" UNIQUE("team_id","email"),
	CONSTRAINT "user_invites_code_key" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "user_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"email" text,
	"team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"locale" text DEFAULT 'en',
	"week_starts_on_monday" boolean DEFAULT false,
	"timezone" text,
	"timezone_auto_sync" boolean DEFAULT true,
	"time_format" numeric DEFAULT 24,
	"date_format" text
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth.users" (
	"instance_id" uuid,
	"id" uuid NOT NULL,
	"aud" varchar(255),
	"role" varchar(255),
	"email" varchar(255),
	"encrypted_password" varchar(255),
	"email_confirmed_at" timestamp with time zone,
	"invited_at" timestamp with time zone,
	"confirmation_token" varchar(255),
	"confirmation_sent_at" timestamp with time zone,
	"recovery_token" varchar(255),
	"recovery_sent_at" timestamp with time zone,
	"email_change_token_new" varchar(255),
	"email_change" varchar(255),
	"email_change_sent_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"raw_app_meta_data" jsonb,
	"raw_user_meta_data" jsonb,
	"is_super_admin" boolean,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"phone" text DEFAULT null::character varying,
	"phone_confirmed_at" timestamp with time zone,
	"phone_change" text DEFAULT ''::character varying,
	"phone_change_token" varchar(255) DEFAULT ''::character varying,
	"phone_change_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
	"email_change_token_current" varchar(255) DEFAULT ''::character varying,
	"email_change_confirm_status" smallint DEFAULT 0,
	"banned_until" timestamp with time zone,
	"reauthentication_token" varchar(255) DEFAULT ''::character varying,
	"reauthentication_sent_at" timestamp with time zone,
	"is_sso_user" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	CONSTRAINT "auth_users_pkey" PRIMARY KEY("id"),
	CONSTRAINT "users_phone_key" UNIQUE("phone"),
	CONSTRAINT "confirmation_token_idx" UNIQUE("confirmation_token"),
	CONSTRAINT "email_change_token_current_idx" UNIQUE("email_change_token_current"),
	CONSTRAINT "email_change_token_new_idx" UNIQUE("email_change_token_new"),
	CONSTRAINT "reauthentication_token_idx" UNIQUE("reauthentication_token"),
	CONSTRAINT "recovery_token_idx" UNIQUE("recovery_token"),
	CONSTRAINT "users_email_partial_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "users_on_team" (
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"role" "teamRoles",
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "members_pkey" PRIMARY KEY("user_id","team_id","id")
);
--> statement-breakpoint
ALTER TABLE "users_on_team" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "integrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_bank_connection_id_fkey" FOREIGN KEY ("bank_connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "public_bank_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tag_assignments" ADD CONSTRAINT "document_tag_assignments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tag_assignments" ADD CONSTRAINT "document_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."document_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tag_assignments" ADD CONSTRAINT "document_tag_assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "storage_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "public"."transaction_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "public_inbox_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "public_inbox_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_inbox_account_id_fkey" FOREIGN KEY ("inbox_account_id") REFERENCES "public"."inbox_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_accounts" ADD CONSTRAINT "inbox_accounts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_embeddings" ADD CONSTRAINT "inbox_embeddings_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_embeddings" ADD CONSTRAINT "inbox_embeddings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_products" ADD CONSTRAINT "invoice_products_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_products" ADD CONSTRAINT "invoice_products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_templates" ADD CONSTRAINT "invoice_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD CONSTRAINT "oauth_applications_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD CONSTRAINT "oauth_applications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "public_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_links" ADD CONSTRAINT "short_links_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_entries" ADD CONSTRAINT "tracker_entries_assigned_id_fkey" FOREIGN KEY ("assigned_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_entries" ADD CONSTRAINT "tracker_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."tracker_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_entries" ADD CONSTRAINT "tracker_entries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_project_tags" ADD CONSTRAINT "project_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_project_tags" ADD CONSTRAINT "project_tags_tracker_project_id_fkey" FOREIGN KEY ("tracker_project_id") REFERENCES "public"."tracker_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_project_tags" ADD CONSTRAINT "tracker_project_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_projects" ADD CONSTRAINT "tracker_projects_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_projects" ADD CONSTRAINT "tracker_projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_reports" ADD CONSTRAINT "public_tracker_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_reports" ADD CONSTRAINT "public_tracker_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."tracker_projects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tracker_reports" ADD CONSTRAINT "tracker_reports_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "public_transaction_attachments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_attachments" ADD CONSTRAINT "public_transaction_attachments_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categories" ADD CONSTRAINT "transaction_categories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_categories" ADD CONSTRAINT "transaction_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."transaction_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_embeddings" ADD CONSTRAINT "transaction_embeddings_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_embeddings" ADD CONSTRAINT "transaction_embeddings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_enrichments" ADD CONSTRAINT "transaction_enrichments_category_slug_team_id_fkey" FOREIGN KEY ("team_id","category_slug") REFERENCES "public"."transaction_categories"("team_id","slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_enrichments" ADD CONSTRAINT "transaction_enrichments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_match_suggestions" ADD CONSTRAINT "transaction_match_suggestions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD CONSTRAINT "transaction_tags_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "public_transactions_assigned_id_fkey" FOREIGN KEY ("assigned_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "public_transactions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_slug_team_id_fkey" FOREIGN KEY ("team_id","category_slug") REFERENCES "public"."transaction_categories"("team_id","slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "public_user_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users_on_team" ADD CONSTRAINT "users_on_team_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "users_on_team" ADD CONSTRAINT "users_on_team_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_notifications_idx" ON "activities" USING btree ("team_id","priority","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activities_insights_idx" ON "activities" USING btree ("team_id","type","source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activities_metadata_gin_idx" ON "activities" USING gin ("metadata");--> statement-breakpoint
CREATE INDEX "activities_group_id_idx" ON "activities" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "activities_insights_group_idx" ON "activities" USING btree ("team_id","group_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_keys_key_idx" ON "api_keys" USING btree ("key_hash" text_ops);--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "api_keys_team_id_idx" ON "api_keys" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "bank_accounts_bank_connection_id_idx" ON "bank_accounts" USING btree ("bank_connection_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "bank_accounts_created_by_idx" ON "bank_accounts" USING btree ("created_by" uuid_ops);--> statement-breakpoint
CREATE INDEX "bank_accounts_team_id_idx" ON "bank_accounts" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "bank_connections_team_id_idx" ON "bank_connections" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "customers_fts" ON "customers" USING gin ("fts" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_document_tag_assignments_document_id" ON "document_tag_assignments" USING btree ("document_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_document_tag_assignments_tag_id" ON "document_tag_assignments" USING btree ("tag_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "document_tag_embeddings_idx" ON "document_tag_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "documents_name_idx" ON "documents" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "documents_team_id_idx" ON "documents" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "documents_team_id_parent_id_idx" ON "documents" USING btree ("team_id" uuid_ops,"parent_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_documents_fts_english" ON "documents" USING gin ("fts_english" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_documents_fts_language" ON "documents" USING gin ("fts_language" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_documents_fts_simple" ON "documents" USING gin ("fts_simple" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_gin_documents_title" ON "documents" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_gin_documents_name" ON "documents" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "exchange_rates_base_target_idx" ON "exchange_rates" USING btree ("base" text_ops,"target" text_ops);--> statement-breakpoint
CREATE INDEX "inbox_attachment_id_idx" ON "inbox" USING btree ("attachment_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_created_at_idx" ON "inbox" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "inbox_team_id_idx" ON "inbox" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_transaction_id_idx" ON "inbox" USING btree ("transaction_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_inbox_account_id_idx" ON "inbox" USING btree ("inbox_account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_embeddings_inbox_id_idx" ON "inbox_embeddings" USING btree ("inbox_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_embeddings_team_id_idx" ON "inbox_embeddings" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "inbox_embeddings_vector_idx" ON "inbox_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "invoice_products_team_id_idx" ON "invoice_products" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "invoice_products_created_by_idx" ON "invoice_products" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "invoice_products_fts_idx" ON "invoice_products" USING gin ("fts");--> statement-breakpoint
CREATE INDEX "invoice_products_name_idx" ON "invoice_products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "invoice_products_usage_count_idx" ON "invoice_products" USING btree ("usage_count");--> statement-breakpoint
CREATE INDEX "invoice_products_last_used_at_idx" ON "invoice_products" USING btree ("last_used_at");--> statement-breakpoint
CREATE INDEX "invoice_products_team_active_idx" ON "invoice_products" USING btree ("team_id","is_active");--> statement-breakpoint
CREATE INDEX "invoices_created_at_idx" ON "invoices" USING btree ("created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "invoices_fts" ON "invoices" USING gin ("fts" tsvector_ops);--> statement-breakpoint
CREATE INDEX "invoices_team_id_idx" ON "invoices" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "notification_settings_user_team_idx" ON "notification_settings" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE INDEX "notification_settings_type_channel_idx" ON "notification_settings" USING btree ("notification_type","channel");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_token_idx" ON "oauth_access_tokens" USING btree ("token" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_refresh_token_idx" ON "oauth_access_tokens" USING btree ("refresh_token" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_application_id_idx" ON "oauth_access_tokens" USING btree ("application_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_user_id_idx" ON "oauth_access_tokens" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "oauth_applications_team_id_idx" ON "oauth_applications" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "oauth_applications_client_id_idx" ON "oauth_applications" USING btree ("client_id" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_applications_slug_idx" ON "oauth_applications" USING btree ("slug" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_code_idx" ON "oauth_authorization_codes" USING btree ("code" text_ops);--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_application_id_idx" ON "oauth_authorization_codes" USING btree ("application_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_user_id_idx" ON "oauth_authorization_codes" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "reports_team_id_idx" ON "reports" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "short_links_short_id_idx" ON "short_links" USING btree ("short_id" text_ops);--> statement-breakpoint
CREATE INDEX "short_links_team_id_idx" ON "short_links" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "short_links_user_id_idx" ON "short_links" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tags_team_id_idx" ON "tags" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tracker_entries_team_id_idx" ON "tracker_entries" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tracker_project_tags_team_id_idx" ON "tracker_project_tags" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tracker_project_tags_tracker_project_id_tag_id_team_id_idx" ON "tracker_project_tags" USING btree ("tracker_project_id" uuid_ops,"tag_id" uuid_ops,"team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tracker_projects_fts" ON "tracker_projects" USING gin ("fts" tsvector_ops);--> statement-breakpoint
CREATE INDEX "tracker_projects_team_id_idx" ON "tracker_projects" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "tracker_reports_team_id_idx" ON "tracker_reports" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_attachments_team_id_idx" ON "transaction_attachments" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_attachments_transaction_id_idx" ON "transaction_attachments" USING btree ("transaction_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_categories_team_id_idx" ON "transaction_categories" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_categories_parent_id_idx" ON "transaction_categories" USING btree ("parent_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_category_embeddings_vector_idx" ON "transaction_category_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "transaction_category_embeddings_system_idx" ON "transaction_category_embeddings" USING btree ("system" bool_ops);--> statement-breakpoint
CREATE INDEX "transaction_embeddings_transaction_id_idx" ON "transaction_embeddings" USING btree ("transaction_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_embeddings_team_id_idx" ON "transaction_embeddings" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_embeddings_vector_idx" ON "transaction_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "transaction_enrichments_category_slug_team_id_idx" ON "transaction_enrichments" USING btree ("category_slug" text_ops,"team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_inbox_id_idx" ON "transaction_match_suggestions" USING btree ("inbox_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_transaction_id_idx" ON "transaction_match_suggestions" USING btree ("transaction_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_team_id_idx" ON "transaction_match_suggestions" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_status_idx" ON "transaction_match_suggestions" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_confidence_idx" ON "transaction_match_suggestions" USING btree ("confidence_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transaction_match_suggestions_lookup_idx" ON "transaction_match_suggestions" USING btree ("transaction_id" uuid_ops,"team_id" uuid_ops,"status" text_ops);--> statement-breakpoint
CREATE INDEX "transaction_tags_tag_id_idx" ON "transaction_tags" USING btree ("tag_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_tags_team_id_idx" ON "transaction_tags" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transaction_tags_transaction_id_tag_id_team_id_idx" ON "transaction_tags" USING btree ("transaction_id" uuid_ops,"tag_id" uuid_ops,"team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_date" ON "transactions" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_fts" ON "transactions" USING gin ("fts_vector" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_fts_vector" ON "transactions" USING gin ("fts_vector" tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_id" ON "transactions" USING btree ("id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_name" ON "transactions" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_name_trigram" ON "transactions" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_team_id_date_name" ON "transactions" USING btree ("team_id" uuid_ops,"date" date_ops,"name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_team_id_name" ON "transactions" USING btree ("team_id" uuid_ops,"name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_trgm_name" ON "transactions" USING gist ("name" gist_trgm_ops);--> statement-breakpoint
CREATE INDEX "transactions_assigned_id_idx" ON "transactions" USING btree ("assigned_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transactions_bank_account_id_idx" ON "transactions" USING btree ("bank_account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transactions_category_slug_idx" ON "transactions" USING btree ("category_slug" text_ops);--> statement-breakpoint
CREATE INDEX "transactions_team_id_date_currency_bank_account_id_category_idx" ON "transactions" USING btree ("team_id" uuid_ops,"date" date_ops,"currency" text_ops,"bank_account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "transactions_team_id_idx" ON "transactions" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "user_invites_team_id_idx" ON "user_invites" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "users_team_id_idx" ON "users" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "users_instance_id_email_idx" ON "auth.users" USING btree ("instance_id",lower((email)::text));--> statement-breakpoint
CREATE INDEX "users_instance_id_idx" ON "auth.users" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "users_is_anonymous_idx" ON "auth.users" USING btree ("is_anonymous");--> statement-breakpoint
CREATE INDEX "users_on_team_team_id_idx" ON "users_on_team" USING btree ("team_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "users_on_team_user_id_idx" ON "users_on_team" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE POLICY "Apps can be deleted by a member of the team" ON "apps" AS PERMISSIVE FOR DELETE TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Apps can be inserted by a member of the team" ON "apps" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "Apps can be selected by a member of the team" ON "apps" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Apps can be updated by a member of the team" ON "apps" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Bank Accounts can be created by a member of the team" ON "bank_accounts" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Bank Accounts can be deleted by a member of the team" ON "bank_accounts" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Bank Accounts can be selected by a member of the team" ON "bank_accounts" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Bank Accounts can be updated by a member of the team" ON "bank_accounts" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Bank Connections can be created by a member of the team" ON "bank_connections" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Bank Connections can be deleted by a member of the team" ON "bank_connections" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Bank Connections can be selected by a member of the team" ON "bank_connections" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Bank Connections can be updated by a member of the team" ON "bank_connections" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Tags can be handled by a member of the team" ON "customer_tags" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Customers can be handled by members of the team" ON "customers" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Tags can be handled by a member of the team" ON "document_tag_assignments" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "document_tag_embeddings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Tags can be handled by a member of the team" ON "document_tags" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Documents can be deleted by a member of the team" ON "documents" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Documents can be selected by a member of the team" ON "documents" AS PERMISSIVE FOR ALL TO public;--> statement-breakpoint
CREATE POLICY "Documents can be updated by a member of the team" ON "documents" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "documents" AS PERMISSIVE FOR INSERT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Enable read access for authenticated users" ON "exchange_rates" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "Inbox can be deleted by a member of the team" ON "inbox" AS PERMISSIVE FOR DELETE TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Inbox can be selected by a member of the team" ON "inbox" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Inbox can be updated by a member of the team" ON "inbox" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Inbox accounts can be deleted by a member of the team" ON "inbox_accounts" AS PERMISSIVE FOR DELETE TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Inbox accounts can be selected by a member of the team" ON "inbox_accounts" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Inbox accounts can be updated by a member of the team" ON "inbox_accounts" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Enable read access for team members" ON "invoice_products" AS PERMISSIVE FOR SELECT TO public USING (team_id = (select auth.jwt() ->> 'team_id')::uuid);--> statement-breakpoint
CREATE POLICY "Enable insert access for team members" ON "invoice_products" AS PERMISSIVE FOR INSERT TO public WITH CHECK (team_id = (select auth.jwt() ->> 'team_id')::uuid);--> statement-breakpoint
CREATE POLICY "Enable update access for team members" ON "invoice_products" AS PERMISSIVE FOR UPDATE TO public USING (team_id = (select auth.jwt() ->> 'team_id')::uuid);--> statement-breakpoint
CREATE POLICY "Enable delete access for team members" ON "invoice_products" AS PERMISSIVE FOR DELETE TO public USING (team_id = (select auth.jwt() ->> 'team_id')::uuid);--> statement-breakpoint
CREATE POLICY "Invoice templates can be handled by a member of the team" ON "invoice_templates" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Invoices can be handled by a member of the team" ON "invoices" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Users can manage their own notification settings" ON "notification_settings" AS PERMISSIVE FOR ALL TO public USING ((user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "OAuth applications can be managed by team members" ON "oauth_applications" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Reports can be created by a member of the team" ON "reports" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Reports can be deleted by a member of the team" ON "reports" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Reports can be selected by a member of the team" ON "reports" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Reports can be updated by member of team" ON "reports" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Short links can be created by a member of the team" ON "short_links" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Short links can be selected by a member of the team" ON "short_links" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Short links can be updated by a member of the team" ON "short_links" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Short links can be deleted by a member of the team" ON "short_links" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Tags can be handled by a member of the team" ON "tags" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "teams" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Invited users can select team if they are invited." ON "teams" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Teams can be deleted by a member of the team" ON "teams" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Teams can be selected by a member of the team" ON "teams" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Teams can be updated by a member of the team" ON "teams" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Entries can be created by a member of the team" ON "tracker_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Entries can be deleted by a member of the team" ON "tracker_entries" AS PERMISSIVE FOR DELETE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Entries can be selected by a member of the team" ON "tracker_entries" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Entries can be updated by a member of the team" ON "tracker_entries" AS PERMISSIVE FOR UPDATE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Tags can be handled by a member of the team" ON "tracker_project_tags" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Projects can be created by a member of the team" ON "tracker_projects" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Projects can be deleted by a member of the team" ON "tracker_projects" AS PERMISSIVE FOR DELETE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Projects can be selected by a member of the team" ON "tracker_projects" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Projects can be updated by a member of the team" ON "tracker_projects" AS PERMISSIVE FOR UPDATE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Reports can be handled by a member of the team" ON "tracker_reports" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Transaction Attachments can be created by a member of the team" ON "transaction_attachments" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Transaction Attachments can be deleted by a member of the team" ON "transaction_attachments" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Transaction Attachments can be selected by a member of the team" ON "transaction_attachments" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Transaction Attachments can be updated by a member of the team" ON "transaction_attachments" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users on team can manage categories" ON "transaction_categories" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Enable read access for authenticated users" ON "transaction_category_embeddings" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "transaction_category_embeddings" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Enable update for authenticated users only" ON "transaction_category_embeddings" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "transaction_enrichments" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Enable update for authenticated users only" ON "transaction_enrichments" AS PERMISSIVE FOR UPDATE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Transaction Tags can be handled by a member of the team" ON "transaction_tags" AS PERMISSIVE FOR ALL TO public USING ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Transactions can be created by a member of the team" ON "transactions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((team_id IN ( SELECT private.get_teams_for_authenticated_user() AS get_teams_for_authenticated_user)));--> statement-breakpoint
CREATE POLICY "Transactions can be deleted by a member of the team" ON "transactions" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "Transactions can be selected by a member of the team" ON "transactions" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Transactions can be updated by a member of the team" ON "transactions" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Enable select for users based on email" ON "user_invites" AS PERMISSIVE FOR SELECT TO public USING (((auth.jwt() ->> 'email'::text) = email));--> statement-breakpoint
CREATE POLICY "User Invites can be created by a member of the team" ON "user_invites" AS PERMISSIVE FOR INSERT TO public;--> statement-breakpoint
CREATE POLICY "User Invites can be deleted by a member of the team" ON "user_invites" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "User Invites can be deleted by invited email" ON "user_invites" AS PERMISSIVE FOR DELETE TO public;--> statement-breakpoint
CREATE POLICY "User Invites can be selected by a member of the team" ON "user_invites" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "User Invites can be updated by a member of the team" ON "user_invites" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Users can insert their own profile." ON "users" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = id));--> statement-breakpoint
CREATE POLICY "Users can select their own profile." ON "users" AS PERMISSIVE FOR SELECT TO public;--> statement-breakpoint
CREATE POLICY "Users can select users if they are in the same team" ON "users" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Users can update own profile." ON "users" AS PERMISSIVE FOR UPDATE TO public;--> statement-breakpoint
CREATE POLICY "Enable insert for authenticated users only" ON "users_on_team" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "Enable updates for users on team" ON "users_on_team" AS PERMISSIVE FOR UPDATE TO "authenticated";--> statement-breakpoint
CREATE POLICY "Select for current user teams" ON "users_on_team" AS PERMISSIVE FOR SELECT TO "authenticated";--> statement-breakpoint
CREATE POLICY "Users on team can be deleted by a member of the team" ON "users_on_team" AS PERMISSIVE FOR DELETE TO public;
