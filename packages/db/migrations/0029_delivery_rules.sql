CREATE TABLE "delivery_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_policies_team_version_key" UNIQUE("team_id","version")
);
--> statement-breakpoint
CREATE TABLE "delivery_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"policy_id" uuid,
	"policy_version" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"rules_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"accounting" text NOT NULL,
	"webhooks" text NOT NULL,
	"resolution" text,
	"resolution_reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_policies" ADD CONSTRAINT "delivery_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_decisions" ADD CONSTRAINT "delivery_decisions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_decisions" ADD CONSTRAINT "delivery_decisions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_decisions" ADD CONSTRAINT "delivery_decisions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."delivery_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_decisions" ADD CONSTRAINT "delivery_decisions_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_decisions_invoice_revision_key" ON "delivery_decisions" USING btree ("invoice_id","revision");--> statement-breakpoint
CREATE INDEX "delivery_decisions_team_id_idx" ON "delivery_decisions" USING btree ("team_id");
