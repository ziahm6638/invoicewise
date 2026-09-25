CREATE TYPE "public"."data_export_status" AS ENUM('queued', 'running', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"requested_by" uuid,
	"status" "data_export_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{"documentsWritten":0,"documentsTotal":0}'::jsonb NOT NULL,
	"summary" jsonb,
	"file_path" text[],
	"file_name" text,
	"size" bigint,
	"sha256" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_exports_team_id_idx" ON "data_exports" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "data_exports_status_idx" ON "data_exports" USING btree ("status");