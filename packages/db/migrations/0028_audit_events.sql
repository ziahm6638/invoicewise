CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_ref" text,
	"surface" text NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"revision" integer,
	"outcome" text NOT NULL,
	"detail" jsonb,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_team_created_at_idx" ON "audit_events" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_team_target_idx" ON "audit_events" USING btree ("team_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workflow_jobs_team_inbox_id_idx" ON "workflow_jobs" USING btree ("team_id",("payload" ->> 'inboxId')) WHERE ("payload" ->> 'inboxId') is not null;--> statement-breakpoint
CREATE INDEX "workflow_jobs_team_invoice_id_idx" ON "workflow_jobs" USING btree ("team_id",("payload" ->> 'invoiceId')) WHERE ("payload" ->> 'invoiceId') is not null;--> statement-breakpoint
CREATE INDEX "workflow_jobs_team_delivery_id_idx" ON "workflow_jobs" USING btree ("team_id",("payload" ->> 'deliveryId')) WHERE ("payload" ->> 'deliveryId') is not null;--> statement-breakpoint
CREATE INDEX "workflow_jobs_team_correction_id_idx" ON "workflow_jobs" USING btree ("team_id",("payload" ->> 'correctionId')) WHERE ("payload" ->> 'correctionId') is not null;
