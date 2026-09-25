ALTER TABLE "webhook_endpoints" ADD COLUMN "previous_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "previous_secret_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "secret_rotated_at" timestamp with time zone;
