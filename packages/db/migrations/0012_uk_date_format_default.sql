ALTER TABLE "users" ALTER COLUMN "date_format" SET DEFAULT 'dd/MM/yyyy';--> statement-breakpoint
UPDATE "users" SET "date_format" = 'dd/MM/yyyy' WHERE "date_format" = 'MM/dd/yyyy';