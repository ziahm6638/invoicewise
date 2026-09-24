/**
 * Disposable Postgres helpers.
 *
 * Every database this module touches is validated as a local, disposable
 * verification database before it is created or reset. Development and
 * production databases and Docker volumes are never addressed.
 */

import { Client } from "pg";
import {
  LOCAL_POSTGRES_BASE,
  assertDisposableDatabaseName,
  assertLoopbackUrl,
} from "./lib";

let parsedBase: URL | undefined;

function postgresBase(): URL {
  if (!parsedBase) {
    parsedBase = assertLoopbackUrl("VERIFY_POSTGRES_BASE", LOCAL_POSTGRES_BASE);
    if (parsedBase.pathname !== "/" && parsedBase.pathname !== "") {
      throw new Error(
        `VERIFY_POSTGRES_BASE is a server base URL and must not name a database: ${LOCAL_POSTGRES_BASE}`,
      );
    }
    parsedBase.pathname = "/";
  }
  return parsedBase;
}

export function databaseUrl(name: string): string {
  assertDisposableDatabaseName(name);
  const url = new URL(postgresBase().toString());
  url.pathname = `/${name}`;
  return url.toString();
}

/** Connects to the local maintenance database on the same loopback server. */
async function withMaintenanceClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const url = new URL(postgresBase().toString());
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Recreates one disposable database. `WITH (FORCE)` terminates only this
 * database's own sessions, so it cannot disturb an unrelated local database.
 */
export async function resetDisposableDatabase(name: string) {
  assertDisposableDatabaseName(name);
  await withMaintenanceClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
}

export async function dropDisposableDatabase(name: string) {
  assertDisposableDatabaseName(name);
  await withMaintenanceClient(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

export type DbQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/** Connects to one already-migrated disposable database. */
export async function connectDisposableDatabase(name: string) {
  const url = databaseUrl(name);
  const client = new Client({ connectionString: url });
  await client.connect();
  const query: DbQuery = async <T>(sql: string, params?: unknown[]) =>
    (await client.query(sql, params as never)).rows as T[];
  return { client, query, url };
}
