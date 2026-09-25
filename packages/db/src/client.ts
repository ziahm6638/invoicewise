import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withReplicas } from "./replicas";
import * as schema from "./schema";

export type DatabaseClientConfig = {
  primaryUrl: string;
  isDevelopment?: boolean;
  /**
   * Connections in the pool. Defaults to `DATABASE_POOL_MAX`, else 8 in
   * development and 10 otherwise. Each process holds its own pool, so the
   * total a deployment can open is this bound times its pools (see
   * docs/deployment.md#capacity).
   */
  maxConnections?: number;
};

const poolMaxFromEnv = () => {
  const value = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

export function createDatabaseClient(config: DatabaseClientConfig) {
  const isDevelopment = config.isDevelopment ?? false;
  const maxConnections =
    config.maxConnections ?? poolMaxFromEnv() ?? (isDevelopment ? 8 : 10);

  const primaryPool = new Pool({
    connectionString: config.primaryUrl,
    max: maxConnections,
    idleTimeoutMillis: isDevelopment ? 5000 : 60000,
    connectionTimeoutMillis: 15000,
    maxUses: isDevelopment ? 100 : 0,
    allowExitOnIdle: true,
  });

  const primaryDb = drizzle(primaryPool, {
    schema,
    casing: "snake_case",
  });
  // One database: reads and writes share the primary. The replica wrapper
  // keeps the `executeOnReplica`/`usePrimaryOnly` surface callers rely on.
  const db = withReplicas(primaryDb, []);

  /** Pool occupancy, for operator diagnostics only (never public health). */
  const getConnectionPoolStats = () => {
    const active = primaryPool.totalCount - primaryPool.idleCount;
    return {
      max: maxConnections,
      open: primaryPool.totalCount,
      idle: primaryPool.idleCount,
      active,
      waiting: primaryPool.waitingCount,
      utilizationPercent: Math.round((active / maxConnections) * 100),
    };
  };

  const close = async () => {
    await primaryPool.end();
  };

  return { close, db, getConnectionPoolStats, primaryDb };
}

const defaultClient = createDatabaseClient({
  primaryUrl: process.env.DATABASE_PRIMARY_URL!,
  isDevelopment: process.env.NODE_ENV === "development",
});

export const db = defaultClient.db;
export const primaryDb = defaultClient.primaryDb;
export const getConnectionPoolStats = defaultClient.getConnectionPoolStats;
export const closeDatabase = defaultClient.close;

// Keep connectDb for backward compatibility, but just return the singleton.
export const connectDb = async () => db;

export type Database = Awaited<ReturnType<typeof connectDb>>;

/**
 * The unwrapped primary connection. Authorization reads use this directly so
 * membership, role and key checks never observe a stale replica.
 */
export type PrimaryDatabase = ReturnType<
  typeof createDatabaseClient
>["primaryDb"];

export type DatabaseWithPrimary = Database & {
  $primary?: Database;
  usePrimaryOnly?: () => Database;
};
