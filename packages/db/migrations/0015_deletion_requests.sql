CREATE TYPE "public"."deletion_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deletion_subject" AS ENUM('workspace', 'account');--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" "deletion_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_name" text,
	"requested_by" uuid,
	"status" "deletion_status" DEFAULT 'pending' NOT NULL,
	"connections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quiesce_until" timestamp with time zone DEFAULT now() NOT NULL,
	"connections_revoked_at" timestamp with time zone,
	"storage_purged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_requests_subject_key" UNIQUE("subject","subject_id")
);
--> statement-breakpoint
CREATE INDEX "deletion_requests_status_idx" ON "deletion_requests" USING btree ("status");