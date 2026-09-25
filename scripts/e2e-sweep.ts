/**
 * Drops stale per-run e2e databases from the shared project Postgres.
 *
 *   bun run e2e:sweep            # drop e2e_<epoch>_<hex> databases older than 1 hour
 *   bun run e2e:sweep --dry-run  # list what would be dropped
 *
 * Only names matching ^e2e_[0-9]+_[0-9a-f]+$ are ever considered, and only
 * when their embedded epoch is more than an hour old, so a run in progress
 * (here or in another worktree) is never touched. `bun run e2e` calls this
 * before every run.
 */

import { Client } from "pg";
import { resolveSharedServices } from "../e2e/support/services";

export const SWEEPABLE = /^e2e_([0-9]+)_[0-9a-f]+$/;
export const MAX_AGE_SECONDS = 60 * 60;

/** Names a sweep drops at `nowSeconds` (pure, for the dry run and the runner). */
export function staleDatabases(names: string[], nowSeconds: number) {
  return names.filter((name) => {
    const match = name.match(SWEEPABLE);
    if (!match) return false;
    return nowSeconds - Number(match[1]) > MAX_AGE_SECONDS;
  });
}

export async function sweep(
  postgresBase: string,
  options: { dryRun?: boolean; log?: (line: string) => void } = {},
) {
  const log = options.log ?? console.log;
  const url = new URL(postgresBase);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like 'e2e\\_%'",
    );
    const stale = staleDatabases(
      rows.map((row) => row.datname),
      Math.floor(Date.now() / 1000),
    );
    for (const name of stale) {
      // Re-checked right before the identifier is interpolated.
      if (!SWEEPABLE.test(name)) continue;
      if (options.dryRun) {
        log(`[sweep] would drop ${name}`);
        continue;
      }
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      log(`[sweep] dropped ${name}`);
    }
    return stale;
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const services = resolveSharedServices();
  const dropped = await sweep(services.postgresBase, {
    dryRun: process.argv.includes("--dry-run"),
  });
  console.log(
    `[sweep] ${dropped.length} stale e2e database(s) on ${services.postgresLabel}`,
  );
}
