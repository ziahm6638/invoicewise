import type { Config } from "drizzle-kit";

const databaseUrl =
  process.env.DATABASE_SESSION_POOLER ?? process.env.DATABASE_PRIMARY_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_SESSION_POOLER or DATABASE_PRIMARY_URL must be set to run database migrations",
  );
}

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
