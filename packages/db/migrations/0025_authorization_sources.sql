CREATE TABLE "authorization_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"reference" text NOT NULL,
	"reference_key" text NOT NULL,
	"current_version_id" uuid,
	"current_version" integer NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"supplier_id" uuid,
	"supplier_name" text,
	"currency" text,
	"authorized_total" numeric(16, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_sources_source_type_check" CHECK ("source_type" IN ('job', 'purchase_order', 'contract')),
	CONSTRAINT "authorization_sources_status_check" CHECK ("status" IN ('open', 'closed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "authorization_sources" ADD CONSTRAINT "authorization_sources_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_sources" ADD CONSTRAINT "authorization_sources_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_sources" ADD CONSTRAINT "authorization_sources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_sources_team_type_reference_key" ON "authorization_sources" USING btree ("team_id","source_type","reference_key");--> statement-breakpoint
CREATE INDEX "authorization_sources_team_updated_at_idx" ON "authorization_sources" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "authorization_sources_team_supplier_idx" ON "authorization_sources" USING btree ("team_id","supplier_id") WHERE "authorization_sources"."supplier_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "authorization_source_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"title" text,
	"scope" text,
	"supplier_id" uuid,
	"supplier_name" text,
	"supplier_vat_number" text,
	"supplier_company_number" text,
	"supplier_resolution" jsonb NOT NULL,
	"currency" text,
	"tax_basis" text,
	"issued_on" date,
	"starts_on" date,
	"ends_on" date,
	"effective_from" date NOT NULL,
	"authorized_total" numeric(16, 2) NOT NULL,
	"line_items" jsonb NOT NULL,
	"change_reason" text,
	"origin" text NOT NULL,
	"import_id" uuid,
	"content_hash" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_source_versions_status_check" CHECK ("status" IN ('open', 'closed', 'cancelled')),
	CONSTRAINT "authorization_source_versions_tax_basis_check" CHECK ("tax_basis" IS NULL OR "tax_basis" IN ('exclusive', 'inclusive', 'not_applicable')),
	CONSTRAINT "authorization_source_versions_origin_check" CHECK ("origin" IN ('manual', 'csv', 'api'))
);
--> statement-breakpoint
ALTER TABLE "authorization_source_versions" ADD CONSTRAINT "authorization_source_versions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_versions" ADD CONSTRAINT "authorization_source_versions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."authorization_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_versions" ADD CONSTRAINT "authorization_source_versions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_versions" ADD CONSTRAINT "authorization_source_versions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_source_versions_source_version_key" ON "authorization_source_versions" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "authorization_source_versions_team_id_idx" ON "authorization_source_versions" USING btree ("team_id");--> statement-breakpoint
CREATE FUNCTION "authorization_source_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Only the foreign keys that are cleared when a user or supplier row is
	-- deleted may change; the recorded terms never do.
	IF (to_jsonb(NEW) - 'actor_id' - 'supplier_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_id' - 'supplier_id') THEN
		RAISE EXCEPTION 'authorization source versions are immutable; record an amendment instead';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "authorization_source_versions_immutable" BEFORE UPDATE ON "authorization_source_versions" FOR EACH ROW EXECUTE FUNCTION "authorization_source_versions_immutable"();--> statement-breakpoint
CREATE TABLE "authorization_source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"file_path" text[] NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorization_source_documents" ADD CONSTRAINT "authorization_source_documents_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_documents" ADD CONSTRAINT "authorization_source_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."authorization_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_documents" ADD CONSTRAINT "authorization_source_documents_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "public"."authorization_source_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_documents" ADD CONSTRAINT "authorization_source_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_source_documents_source_sha256_key" ON "authorization_source_documents" USING btree ("source_id","sha256");--> statement-breakpoint
CREATE INDEX "authorization_source_documents_team_id_idx" ON "authorization_source_documents" USING btree ("team_id");--> statement-breakpoint
CREATE TABLE "authorization_source_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"actor_id" uuid,
	"origin" text NOT NULL,
	"file_name" text,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"errors" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_source_imports_status_check" CHECK ("status" IN ('applied', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "authorization_source_imports" ADD CONSTRAINT "authorization_source_imports_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_source_imports" ADD CONSTRAINT "authorization_source_imports_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorization_source_imports_team_created_at_idx" ON "authorization_source_imports" USING btree ("team_id","created_at");
