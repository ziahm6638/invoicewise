import { replicationCache } from "@invoicewise/cache/replication-cache";
import type { DatabaseWithPrimary } from "@invoicewise/db/client";
import type { MiddlewareHandler } from "hono";

/**
 * Database middleware that handles replication lag based on mutation operations
 * For mutations: always use primary DB
 * For queries: use primary DB if the team recently performed a mutation
 */
export const withPrimaryReadAfterWrite: MiddlewareHandler = async (c, next) => {
  // Get session and database from context
  const session = c.get("session");
  const db = c.get("db");

  // Determine operation type based on HTTP method
  const method = c.req.method;
  const operationType = ["POST", "PUT", "PATCH", "DELETE"].includes(method)
    ? "mutation"
    : "query";

  const teamId = session?.teamId ?? null;

  let finalDb = db;

  if (teamId) {
    // For mutations, always use primary DB and update the team's timestamp
    if (operationType === "mutation") {
      await replicationCache.set(teamId);

      // Use primary-only mode to maintain interface consistency
      const dbWithPrimary = db as DatabaseWithPrimary;
      if (dbWithPrimary.usePrimaryOnly) {
        finalDb = dbWithPrimary.usePrimaryOnly();
      }
      // If usePrimaryOnly doesn't exist, we're already using the primary DB
    }
    // For queries, check if the team recently performed a mutation
    else {
      const timestamp = await replicationCache.get(teamId);
      const now = Date.now();

      // If the timestamp exists and hasn't expired, use primary DB
      if (timestamp && now < timestamp) {
        // Use primary-only mode to maintain interface consistency
        const dbWithPrimary = db as DatabaseWithPrimary;
        if (dbWithPrimary.usePrimaryOnly) {
          finalDb = dbWithPrimary.usePrimaryOnly();
        }
      }
    }
  }

  // Set database and context in Hono context
  c.set("db", finalDb);
  c.set("session", session);
  c.set("teamId", teamId);

  await next();
};
