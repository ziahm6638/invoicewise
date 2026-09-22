ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "inbox_id" SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);--> statement-breakpoint
UPDATE "teams" SET "slug" = "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "slug" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_invites" ALTER COLUMN "code" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
UPDATE "user_invites" SET "code" = gen_random_uuid()::text WHERE "code" IS NULL OR "code" = 'nanoid(24)';--> statement-breakpoint
ALTER TABLE "user_invites" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_invites" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '2 days' NOT NULL;--> statement-breakpoint

INSERT INTO "users" (
  "id",
  "full_name",
  "avatar_url",
  "email",
  "email_verified",
  "created_at",
  "updated_at"
)
SELECT
  auth_user."id",
  COALESCE(
    auth_user."raw_user_meta_data" ->> 'full_name',
    auth_user."raw_user_meta_data" ->> 'name',
    split_part(auth_user."email", '@', 1)
  ),
  auth_user."raw_user_meta_data" ->> 'avatar_url',
  auth_user."email",
  auth_user."email_confirmed_at" IS NOT NULL,
  COALESCE(auth_user."created_at", now()),
  COALESCE(auth_user."updated_at", auth_user."created_at", now())
FROM "auth.users" auth_user
ON CONFLICT ("id") DO UPDATE SET
  "full_name" = COALESCE("users"."full_name", EXCLUDED."full_name"),
  "avatar_url" = COALESCE("users"."avatar_url", EXCLUDED."avatar_url"),
  "email" = COALESCE("users"."email", EXCLUDED."email"),
  "email_verified" = EXCLUDED."email_verified",
  "updated_at" = EXCLUDED."updated_at";--> statement-breakpoint

CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_slug_key" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "users_on_team" ADD CONSTRAINT "users_on_team_id_key" UNIQUE("id");--> statement-breakpoint

CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" uuid NOT NULL,
  "active_organization_id" uuid,
  CONSTRAINT "auth_sessions_token_key" UNIQUE("token"),
  CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "auth_sessions_active_organization_id_fkey" FOREIGN KEY ("active_organization_id") REFERENCES "teams"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_active_organization_id_idx" ON "auth_sessions" ("active_organization_id");--> statement-breakpoint

CREATE TABLE "auth_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_accounts_provider_account_key" UNIQUE("provider_id", "account_id"),
  CONSTRAINT "auth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" ("user_id");--> statement-breakpoint

INSERT INTO "auth_accounts" (
  "account_id",
  "provider_id",
  "user_id",
  "password",
  "created_at",
  "updated_at"
)
SELECT
  auth_user."id"::text,
  'credential',
  auth_user."id",
  NULLIF(auth_user."encrypted_password", ''),
  COALESCE(auth_user."created_at", now()),
  COALESCE(auth_user."updated_at", auth_user."created_at", now())
FROM "auth.users" auth_user
JOIN "users" app_user ON app_user."id" = auth_user."id"
ON CONFLICT ("provider_id", "account_id") DO NOTHING;--> statement-breakpoint

CREATE TABLE "auth_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" ("identifier");--> statement-breakpoint

DROP TABLE "auth.users";
