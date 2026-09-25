CREATE TABLE "provider_usage" (
	"hour" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"throttled" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "provider_usage_pkey" PRIMARY KEY("hour","provider","operation")
);
