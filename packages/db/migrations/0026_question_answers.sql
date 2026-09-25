ALTER TYPE "public"."invoice_question_type" ADD VALUE 'number';--> statement-breakpoint
CREATE TABLE "document_texts" (
	"inbox_id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"chars" integer NOT NULL,
	"truncated" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_version_id" uuid NOT NULL,
	"invoice_revision" integer NOT NULL,
	"judgment" jsonb NOT NULL,
	"previous" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_answers_run_invoice_key" UNIQUE("run_id","invoice_id")
);
--> statement-breakpoint
CREATE TABLE "question_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_version_id" uuid NOT NULL,
	"question_version" integer NOT NULL,
	"invoice_ids" uuid[] NOT NULL,
	"status" text NOT NULL,
	"answered" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_questions" ADD COLUMN "number_format" jsonb;--> statement-breakpoint
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_texts" ADD CONSTRAINT "document_texts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."inbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_answers" ADD CONSTRAINT "question_answers_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."question_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_runs" ADD CONSTRAINT "question_runs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_runs" ADD CONSTRAINT "question_runs_question_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "public"."user_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_runs" ADD CONSTRAINT "question_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_texts_team_id_idx" ON "document_texts" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "question_answers_team_invoice_idx" ON "question_answers" USING btree ("team_id","invoice_id");--> statement-breakpoint
CREATE INDEX "question_runs_team_question_idx" ON "question_runs" USING btree ("team_id","question_key","created_at");