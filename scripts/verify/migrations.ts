/**
 * Migration verification: empty-database bootstrap, upgrade from the recorded
 * prior schema at ef798a99 (migrations through 0006), and an injected migration
 * failure with documented forward recovery.
 *
 * Only disposable databases are used, and each one is validated before it is
 * created or reset.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectDisposableDatabase,
  databaseUrl,
  dropDisposableDatabase,
  resetDisposableDatabase,
} from "./database";
import {
  ROOT,
  type Verification,
  assertDisposableDatabaseName,
  syntheticEnv,
} from "./lib";

const PRIOR_SCHEMA_THROUGH = 6;
const TOTAL_MIGRATIONS = 18;

const PRIOR_SCHEMA_BASELINE = join(
  ROOT,
  "scripts",
  "verify",
  "prior-schema-baseline.json",
);

/**
 * The upgrade fixture copies the working tree's 0000-0006 files, so it must
 * prove they still reproduce the recorded prior schema rather than a mutable
 * copy of today's content.
 */
export async function assertPriorSchemaPinned(
  migrationsDir: string,
): Promise<string> {
  const baseline = (await Bun.file(PRIOR_SCHEMA_BASELINE).json()) as {
    pinnedAt: string;
    files: Record<string, string>;
  };
  const mismatches: string[] = [];
  for (const [relativePath, expected] of Object.entries(baseline.files)) {
    const name = relativePath.split("/").pop() ?? relativePath;
    const actual = createHash("sha256")
      .update(await Bun.file(join(migrationsDir, name)).bytes())
      .digest("hex");
    if (actual !== expected) {
      mismatches.push(
        `${relativePath} (${actual.slice(0, 12)} != ${expected.slice(0, 12)})`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `prior-schema migrations no longer match ${baseline.pinnedAt}: ${mismatches.join(
        ", ",
      )}. Update scripts/verify/prior-schema-baseline.json deliberately, with a migration review note.`,
    );
  }
  return `${Object.keys(baseline.files).length} prior-schema migration files match the ${
    baseline.pinnedAt
  } hashes`;
}

export const FRESH_DATABASE = "invoicewise_migrations_fresh_test";
export const UPGRADE_DATABASE = "invoicewise_migrations_upgrade_test";
export const RECOVERY_DATABASE = "invoicewise_migrations_recovery_test";

const seeded = {
  userId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333",
  inboxId: "44444444-4444-4444-8444-444444444444",
  jobId: "55555555-5555-4555-8555-555555555555",
  email: "legacy-owner@example.test",
  referenceId: "LEGACY-REF-0001",
  amount: "1234.56",
  currency: "GBP",
  filePath: ["22222222-2222-4222-8222-222222222222", "inbox", "legacy.pdf"],
  extraction: {
    supplierName: "Legacy Supplier Ltd",
    invoiceNumber: "LEGACY-REF-0001",
    grossAmount: 1234.56,
  },
  jobPayload: { inboxId: "44444444-4444-4444-8444-444444444444" },
  idempotencyKey: "legacy-upgrade-fixture",
};

async function seedPriorSchema(
  query: Awaited<ReturnType<typeof connectDisposableDatabase>>["query"],
) {
  await query(
    `insert into teams (id, name, slug, created_at)
     values ($1, 'Legacy Workspace', 'legacy-workspace', now())`,
    [seeded.teamId],
  );
  await query(
    `insert into users (id, email, full_name, email_verified, team_id, created_at)
     values ($1, $2, 'Legacy Owner', true, $3, now())`,
    [seeded.userId, seeded.email, seeded.teamId],
  );
  await query(
    `insert into users_on_team (id, user_id, team_id, role, created_at)
     values ($1, $2, $3, 'owner', now())`,
    [seeded.membershipId, seeded.userId, seeded.teamId],
  );
  await query(
    `insert into inbox (id, team_id, file_path, file_name, display_name, amount,
       currency, reference_id, extraction, status, type, created_at)
     values ($1, $2, $3, 'legacy.pdf', 'legacy.pdf', $4, $5, $6, $7::jsonb,
       'new', 'invoice', now())`,
    [
      seeded.inboxId,
      seeded.teamId,
      seeded.filePath,
      seeded.amount,
      seeded.currency,
      seeded.referenceId,
      JSON.stringify(seeded.extraction),
    ],
  );
  await query(
    `insert into workflow_jobs (id, name, team_id, payload, status, idempotency_key, run_at)
     values ($1, 'attachment', $2, $3::jsonb, 'queued', $4, now())`,
    [
      seeded.jobId,
      seeded.teamId,
      JSON.stringify(seeded.jobPayload),
      seeded.idempotencyKey,
    ],
  );
}

async function assertSeedPreserved(
  query: Awaited<ReturnType<typeof connectDisposableDatabase>>["query"],
) {
  const [user] = await query<{ id: string; email: string; team_id: string }>(
    "select id, email, team_id from users where id = $1",
    [seeded.userId],
  );
  if (!user || user.email !== seeded.email || user.team_id !== seeded.teamId) {
    throw new Error("seeded user identity changed across the migration");
  }

  const [membership] = await query<{ role: string }>(
    "select role from users_on_team where id = $1",
    [seeded.membershipId],
  );
  if (membership?.role !== "owner") {
    throw new Error("seeded workspace membership changed across the migration");
  }

  const [invoice] = await query<{
    id: string;
    team_id: string;
    amount: string;
    currency: string;
    reference_id: string;
    file_path: string[];
    extraction: Record<string, unknown>;
  }>(
    `select id, team_id, amount::text as amount, currency, reference_id,
            file_path, extraction
       from inbox where id = $1`,
    [seeded.inboxId],
  );
  if (!invoice) throw new Error("seeded inbox row did not survive migration");
  if (invoice.amount !== seeded.amount) {
    throw new Error(
      `seeded financial amount changed: ${invoice.amount} != ${seeded.amount}`,
    );
  }
  if (invoice.currency !== seeded.currency) {
    throw new Error("seeded currency changed across the migration");
  }
  if (invoice.reference_id !== seeded.referenceId) {
    throw new Error("seeded source reference changed across the migration");
  }
  if (invoice.file_path.join("/") !== seeded.filePath.join("/")) {
    throw new Error("seeded source file path changed across the migration");
  }
  if (
    invoice.extraction?.supplierName !== seeded.extraction.supplierName ||
    invoice.extraction?.invoiceNumber !== seeded.extraction.invoiceNumber
  ) {
    throw new Error("seeded extraction evidence changed across the migration");
  }

  const [job] = await query<{
    status: string;
    payload: Record<string, unknown>;
  }>("select status, payload from workflow_jobs where id = $1", [seeded.jobId]);
  if (job?.status !== "queued" || job.payload?.inboxId !== seeded.inboxId) {
    throw new Error("seeded queue row did not survive the migration");
  }

  return `preserved user ${seeded.userId}, workspace ${seeded.teamId}, inbox ${seeded.inboxId} (${seeded.amount} ${seeded.currency}, ref ${seeded.referenceId}) and queued job ${seeded.jobId}`;
}

async function journalCount(name: string) {
  const { client, query } = await connectDisposableDatabase(name);
  try {
    const [row] = await query<{ count: string }>(
      "select count(*)::text as count from drizzle.__drizzle_migrations",
    );
    return Number(row?.count ?? -1);
  } finally {
    await client.end();
  }
}

async function columnExists(name: string, table: string, column: string) {
  const { client, query } = await connectDisposableDatabase(name);
  try {
    const [row] = await query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = $2`,
      [table, column],
    );
    return Number(row?.count ?? 0) > 0;
  } finally {
    await client.end();
  }
}

type MigrationContext = {
  v: Verification;
  databaseDir: string;
  migrateEnv: (database: string) => Record<string, string>;
};

function migrateSpec(
  context: MigrationContext,
  database: string,
  config?: string,
) {
  return {
    command: "bun",
    args: [
      "--no-env-file",
      "x",
      "drizzle-kit",
      "migrate",
      ...(config ? ["--config", config] : []),
    ],
    cwd: context.databaseDir,
    env: context.migrateEnv(database),
  };
}

/**
 * Builds a migrations directory containing only migrations through 0006 plus
 * the matching drizzle journal, so the upgrade path starts from exactly the
 * schema recorded at ef798a99.
 */
async function writePriorSchemaMigrations(
  v: Verification,
  tag: string,
  context: MigrationContext,
) {
  const migrationsDir = join(context.databaseDir, "migrations");
  const outDir = join(v.tmpDir, `prior-schema-${tag}`, "migrations");
  const metaDir = join(outDir, "meta");
  await mkdir(metaDir, { recursive: true });

  const entries = await readdir(migrationsDir);
  for (const entry of entries) {
    const index = Number(entry.slice(0, 4));
    if (entry.endsWith(".sql") && index <= PRIOR_SCHEMA_THROUGH) {
      await copyFile(join(migrationsDir, entry), join(outDir, entry));
    }
  }

  const journal = await Bun.file(
    join(migrationsDir, "meta", "_journal.json"),
  ).json();
  const trimmed = {
    ...journal,
    entries: journal.entries.filter(
      (entry: { idx: number }) => entry.idx <= PRIOR_SCHEMA_THROUGH,
    ),
  };
  const journalPath = join(metaDir, "_journal.json");
  await Bun.write(journalPath, `${JSON.stringify(trimmed, null, 2)}\n`);

  const configPath = join(v.tmpDir, `prior-schema-${tag}`, "drizzle.config.ts");
  await writeFile(
    configPath,
    [
      'import type { Config } from "drizzle-kit";',
      "export default {",
      `  schema: ${JSON.stringify(join(context.databaseDir, "src", "schema.ts"))},`,
      `  out: ${JSON.stringify(outDir)},`,
      '  dialect: "postgresql",',
      "  dbCredentials: { url: process.env.DATABASE_PRIMARY_URL! },",
      "} satisfies Config;",
      "",
    ].join("\n"),
  );

  return { configPath, journalPath, outDir };
}

export async function runMigrationVerification(
  v: Verification,
  baseEnv: Record<string, string>,
  workspaceRoot: string,
) {
  assertDisposableDatabaseName(FRESH_DATABASE);
  assertDisposableDatabaseName(UPGRADE_DATABASE);
  assertDisposableDatabaseName(RECOVERY_DATABASE);

  const databaseDir = join(workspaceRoot, "packages", "db");
  const context: MigrationContext = {
    v,
    databaseDir,
    migrateEnv: (database) =>
      syntheticEnv({ ...baseEnv, DATABASE_PRIMARY_URL: databaseUrl(database) }),
  };

  await v.requireCheck("migrations:prior-schema-pinned", async () =>
    assertPriorSchemaPinned(join(databaseDir, "migrations")),
  );

  v.onCleanup("drop migration verification databases", async () => {
    for (const database of [
      FRESH_DATABASE,
      UPGRADE_DATABASE,
      RECOVERY_DATABASE,
    ]) {
      await dropDisposableDatabase(database);
    }
  });

  // 1. Empty-database bootstrap.
  await resetDisposableDatabase(FRESH_DATABASE);
  await v.runStep(
    "migrations:fresh-bootstrap",
    migrateSpec(context, FRESH_DATABASE),
  );
  await v.runCheck("migrations:fresh-schema", async () => {
    const count = await journalCount(FRESH_DATABASE);
    if (count !== TOTAL_MIGRATIONS) {
      throw new Error(
        `expected ${TOTAL_MIGRATIONS} applied migrations, found ${count}`,
      );
    }
    const expectedColumns: [string, string][] = [
      ["inbox", "intake_state"],
      ["inbox", "content_hash"],
      ["inbox", "intake_error"],
      ["inbox", "object_removal_pending"],
      ["inbox", "object_removal_ambiguous"],
      ["inbox", "processing_error"],
      ["inbox", "intake_publishing_until"],
      ["inbox", "validation"],
    ];
    for (const [table, column] of expectedColumns) {
      if (!(await columnExists(FRESH_DATABASE, table, column))) {
        throw new Error(`missing column ${table}.${column} after bootstrap`);
      }
    }
    const { client, query } = await connectDisposableDatabase(FRESH_DATABASE);
    try {
      const [role] = await query<{ count: string }>(
        `select count(*)::text as count from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'teamRoles' and e.enumlabel = 'admin'`,
      );
      if (Number(role?.count ?? 0) !== 1) {
        throw new Error("teamRoles enum is missing the admin value");
      }
      const [index] = await query<{ count: string }>(
        `select count(*)::text as count from pg_indexes
          where schemaname = 'public' and indexname = 'inbox_team_reference_id_key'`,
      );
      if (Number(index?.count ?? 0) !== 1) {
        throw new Error("workspace-scoped reference identity index is missing");
      }
    } finally {
      await client.end();
    }
    return `bootstrap applied ${count} migrations with the current intake, role and reference-identity schema`;
  });

  // 2. Upgrade from the recorded prior schema with representative data.
  await resetDisposableDatabase(UPGRADE_DATABASE);
  const upgrade = await writePriorSchemaMigrations(v, "upgrade", context);
  await v.runStep(
    "migrations:prior-schema-0006",
    migrateSpec(context, UPGRADE_DATABASE, upgrade.configPath),
  );
  await v.runCheck("migrations:seed-prior-schema", async () => {
    const count = await journalCount(UPGRADE_DATABASE);
    if (count !== PRIOR_SCHEMA_THROUGH + 1) {
      throw new Error(
        `expected the prior schema at ${PRIOR_SCHEMA_THROUGH + 1} migrations, found ${count}`,
      );
    }
    if (await columnExists(UPGRADE_DATABASE, "inbox", "intake_state")) {
      throw new Error(
        "prior schema unexpectedly already contains inbox.intake_state",
      );
    }
    const { client, query } = await connectDisposableDatabase(UPGRADE_DATABASE);
    try {
      await seedPriorSchema(query);
    } finally {
      await client.end();
    }
    return "seeded synthetic user, membership, invoice and queued workflow row on the 0006 schema";
  });
  await v.runStep("migrations:upgrade", migrateSpec(context, UPGRADE_DATABASE));
  await v.runCheck("migrations:upgrade-preserves-data", async () => {
    const count = await journalCount(UPGRADE_DATABASE);
    if (count !== TOTAL_MIGRATIONS) {
      throw new Error(
        `upgrade did not reach ${TOTAL_MIGRATIONS} migrations (found ${count})`,
      );
    }
    if (
      !(await columnExists(UPGRADE_DATABASE, "inbox", "object_removal_pending"))
    ) {
      throw new Error("upgrade did not add inbox.object_removal_pending");
    }
    const { client, query } = await connectDisposableDatabase(UPGRADE_DATABASE);
    try {
      return await assertSeedPreserved(query);
    } finally {
      await client.end();
    }
  });

  // 3. Injected migration failure plus documented forward recovery.
  await resetDisposableDatabase(RECOVERY_DATABASE);
  const recovery = await writePriorSchemaMigrations(v, "recovery", context);
  await v.runStep(
    "migrations:recovery-prior-schema-0006",
    migrateSpec(context, RECOVERY_DATABASE, recovery.configPath),
  );
  await v.runCheck("migrations:recovery-seed", async () => {
    const { client, query } =
      await connectDisposableDatabase(RECOVERY_DATABASE);
    try {
      await seedPriorSchema(query);
      // Fault injection: a pre-existing object that migration 0008 must create.
      await query(
        `create type public.inbox_intake_state as enum ('injected_conflict')`,
      );
    } finally {
      await client.end();
    }
    return "injected a conflicting inbox_intake_state type before migration 0008";
  });
  const failure = await v.runStep("migrations:injected-failure", {
    ...migrateSpec(context, RECOVERY_DATABASE),
    expectFailure: true,
    outputIncludes: 'type "inbox_intake_state" already exists',
  });
  await v.runCheck("migrations:failure-is-partial", async () => {
    if (!failure.ok) {
      throw new Error("the injected migration failure was not observed");
    }
    const count = await journalCount(RECOVERY_DATABASE);
    // drizzle-kit applies the pending batch inside one transaction, so the
    // failed batch rolls back and the database stays at the last committed
    // migration set instead of half-applying 0007-0011.
    if (count !== PRIOR_SCHEMA_THROUGH + 1) {
      throw new Error(
        `expected the database to stay at ${PRIOR_SCHEMA_THROUGH + 1} applied migrations, found ${count}`,
      );
    }
    if (await columnExists(RECOVERY_DATABASE, "inbox", "intake_state")) {
      throw new Error("failed migration left a partially applied 0008 change");
    }
    return "the failed migration batch rolled back; the database stayed at the prior committed migration set";
  });
  await v.runCheck("migrations:forward-recovery", async () => {
    const { client, query } =
      await connectDisposableDatabase(RECOVERY_DATABASE);
    try {
      await query("drop type public.inbox_intake_state");
    } finally {
      await client.end();
    }
    return "documented recovery: resolve the conflicting object, then re-run `bun run db:migrate` (no database reset)";
  });
  await v.runStep(
    "migrations:recovery-rerun",
    migrateSpec(context, RECOVERY_DATABASE),
  );
  await v.runCheck("migrations:recovery-preserves-data", async () => {
    const count = await journalCount(RECOVERY_DATABASE);
    if (count !== TOTAL_MIGRATIONS) {
      throw new Error(
        `recovery did not reach ${TOTAL_MIGRATIONS} migrations (found ${count})`,
      );
    }
    if (!(await columnExists(RECOVERY_DATABASE, "inbox", "intake_state"))) {
      throw new Error("recovery did not apply inbox.intake_state");
    }
    const { client, query } =
      await connectDisposableDatabase(RECOVERY_DATABASE);
    try {
      return await assertSeedPreserved(query);
    } finally {
      await client.end();
    }
  });
}
