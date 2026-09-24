import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { withReplicas } from "./replicas";
import * as schema from "./schema";

export type DatabaseClientConfig = {
  primaryUrl: string;
  replicaUrls?: {
    fra: string;
    sjc: string;
    iad: string;
  };
  region?: string;
  instance?: string;
  isDevelopment?: boolean;
};

export function createDatabaseClient(config: DatabaseClientConfig) {
  const isDevelopment = config.isDevelopment ?? false;
  const connectionConfig = {
    max: isDevelopment ? 8 : 12,
    idleTimeoutMillis: isDevelopment ? 5000 : 60000,
    connectionTimeoutMillis: 15000,
    maxUses: isDevelopment ? 100 : 0,
    allowExitOnIdle: true,
  };

  const primaryPool = new Pool({
    connectionString: config.primaryUrl,
    ...connectionConfig,
  });
  const replicaPools = config.replicaUrls
    ? {
        fra: new Pool({
          connectionString: config.replicaUrls.fra,
          ...connectionConfig,
        }),
        sjc: new Pool({
          connectionString: config.replicaUrls.sjc,
          ...connectionConfig,
        }),
        iad: new Pool({
          connectionString: config.replicaUrls.iad,
          ...connectionConfig,
        }),
      }
    : null;

  const primaryDb = drizzle(primaryPool, {
    schema,
    casing: "snake_case",
  });
  const replicaDatabases = replicaPools
    ? [
        drizzle(replicaPools.fra, { schema, casing: "snake_case" }),
        drizzle(replicaPools.iad, { schema, casing: "snake_case" }),
        drizzle(replicaPools.sjc, { schema, casing: "snake_case" }),
      ]
    : [];
  const replicaIndex =
    config.region === "iad" ? 1 : config.region === "sjc" ? 2 : 0;
  const db = withReplicas(
    primaryDb,
    replicaDatabases,
    (replicas) => replicas[replicaIndex]!,
  );

  const getConnectionPoolStats = () => {
    const getPoolStats = (pool: Pool, name: string) => {
      try {
        return {
          name,
          total: pool.options.max || 0,
          idle: pool.idleCount || 0,
          active: pool.totalCount - pool.idleCount,
          waiting: pool.waitingCount || 0,
          ended: pool.ended || false,
        };
      } catch (error) {
        return {
          name,
          error: error instanceof Error ? error.message : String(error),
          total: 0,
          idle: 0,
          active: 0,
          waiting: 0,
          ended: true,
        };
      }
    };

    const pools: Record<string, ReturnType<typeof getPoolStats>> = {
      primary: getPoolStats(primaryPool, "primary"),
    };
    if (replicaPools) {
      pools.fra = getPoolStats(replicaPools.fra, "fra");
      pools.sjc = getPoolStats(replicaPools.sjc, "sjc");
      pools.iad = getPoolStats(replicaPools.iad, "iad");
    }

    const poolArray = Object.values(pools);
    const totalActive = poolArray.reduce(
      (sum, pool) => sum + (pool.active || 0),
      0,
    );
    const totalWaiting = poolArray.reduce(
      (sum, pool) => sum + (pool.waiting || 0),
      0,
    );
    const hasExhaustedPools = poolArray.some(
      (pool) =>
        (pool.active || 0) >= (pool.total || 0) || (pool.waiting || 0) > 0,
    );
    const connectionsPerPool = isDevelopment ? 8 : 12;
    const totalConnections = connectionsPerPool * (replicaPools ? 4 : 1);

    return {
      timestamp: new Date().toISOString(),
      region: config.region || "unknown",
      instance: config.instance || "local",
      pools,
      summary: {
        totalConnections,
        totalActive,
        totalWaiting,
        hasExhaustedPools,
        utilizationPercent: Math.round((totalActive / totalConnections) * 100),
      },
    };
  };

  const close = async () => {
    await Promise.all(
      [primaryPool, ...(replicaPools ? Object.values(replicaPools) : [])].map(
        (pool) => pool.end(),
      ),
    );
  };

  return { close, db, getConnectionPoolStats, primaryDb };
}

const replicaUrls =
  process.env.DATABASE_FRA_URL &&
  process.env.DATABASE_SJC_URL &&
  process.env.DATABASE_IAD_URL
    ? {
        fra: process.env.DATABASE_FRA_URL,
        sjc: process.env.DATABASE_SJC_URL,
        iad: process.env.DATABASE_IAD_URL,
      }
    : undefined;
const defaultClient = createDatabaseClient({
  primaryUrl: process.env.DATABASE_PRIMARY_URL!,
  replicaUrls,
  region: process.env.FLY_REGION,
  instance: process.env.FLY_ALLOC_ID,
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
