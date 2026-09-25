/**
 * The paved path, enforced (run by `bun run lint`; see docs/paved-path.md).
 *
 * Rules:
 *   db-access       drizzle-orm / pg / postgres are imported only in the data
 *                   layer (packages/db) and verification tooling.
 *   money-columns   a money column in packages/db/src/schema.ts is an integer
 *                   of minor units (pence): integer()/bigint(), never
 *                   numeric/numericCasted/doublePrecision/real.
 *   migrations      packages/db/migrations and meta/_journal.json agree: one
 *                   NNNN_name.sql per entry, idx in order, `when` increasing.
 *   workflows       every WorkflowRequest name in packages/jobs/src/schema.ts
 *                   has a `case` in packages/jobs/src/workflows.ts and back.
 *   routes          dashboard pages live under [locale]/(app) or
 *                   [locale]/(public), URL segments are kebab-case, and
 *                   route handlers live under src/app/api.
 *   provider-hosts  a provider's API host appears only in its adapter
 *                   (Xero/QuickBooks only through Nango).
 *
 * Existing offenders are listed in `.paved-path-allowlist.txt` as
 * `<rule> <key>`; that list may only shrink (compared with the base branch).
 *
 *   bun scripts/check-paved-path.ts                  # check
 *   bun scripts/check-paved-path.ts --print-offenders # every current offender
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const ALLOWLIST = ".paved-path-allowlist.txt";

export type Offence = { rule: string; key: string; message: string };

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
};

const IGNORED =
  /(^|\/)(node_modules|\.next|dist|build|coverage|\.turbo|\.verify-artifacts|\.wrangler|graft)\//;

function sourceFiles(root: string) {
  const listed = git([
    "-C",
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed === null) throw new Error("git ls-files failed");
  return listed
    .split("\n")
    .filter((path) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path))
    .filter((path) => !IGNORED.test(path))
    .filter((path) => existsSync(join(root, path)));
}

const isTestFile = (path: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

// ---------------------------------------------------------------- db-access
const DB_DRIVER_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](drizzle-orm(?:\/[^"']*)?|pg|postgres)["']/;

export const isDataLayerOrTooling = (path: string) =>
  path.startsWith("packages/db/") ||
  path.startsWith("scripts/") ||
  path.startsWith("e2e/") ||
  path.startsWith("invariants/") ||
  /(^|\/)src\/verify-[^/]+\.ts$/.test(path) ||
  isTestFile(path);

export function checkDbAccess(files: { path: string; text: string }[]) {
  const offences: Offence[] = [];
  for (const { path, text } of files) {
    if (isDataLayerOrTooling(path)) continue;
    const match = text.match(DB_DRIVER_IMPORT);
    if (match) {
      offences.push({
        rule: "db-access",
        key: path,
        message: `${path} imports "${match[1]}": database access belongs in packages/db (add a query in packages/db/src/queries and call it)`,
      });
    }
  }
  return offences;
}

// ------------------------------------------------------------ money-columns
const MONEY_NAME =
  /(amount|balance|price|total|subtotal|^tax$|^vat$|discount|fee|cost)/i;
const NOT_MONEY = /([Rr]ate|[Ss]core|[Pp]ercent|[a-z]Count)$/;
const COLUMN =
  /^\s+([A-Za-z0-9_]+):\s*(numericCasted|numeric|doublePrecision|real|integer|bigint|smallint)\(/;

export function checkMoneyColumns(schema: string) {
  const offences: Offence[] = [];
  let table = "";
  let awaitingName = false;
  for (const line of schema.split("\n")) {
    // `export const invoices = pgTable(\n  "invoices",` or on one line.
    const declared = line.match(/pgTable\(\s*["']([a-z0-9_]+)["']/);
    if (declared) {
      table = declared[1]!;
      awaitingName = false;
    } else if (/pgTable\(\s*$/.test(line)) {
      awaitingName = true;
      continue;
    } else if (awaitingName) {
      const name = line.match(/^\s*["']([a-z0-9_]+)["']/);
      if (name) table = name[1]!;
      awaitingName = false;
      continue;
    }
    const column = line.match(COLUMN);
    if (!column || !table) continue;
    const [, name, type] = column;
    if (!MONEY_NAME.test(name!) || NOT_MONEY.test(name!)) continue;
    if (type === "integer" || type === "bigint") continue;
    offences.push({
      rule: "money-columns",
      key: `${table}.${name}`,
      message: `${table}.${name} is ${type}(): store money as integer minor units (pence) with integer()/bigint()`,
    });
  }
  return offences;
}

// --------------------------------------------------------------- migrations
export function checkMigrations(dir: string) {
  const offences: Offence[] = [];
  const add = (key: string, message: string) =>
    offences.push({ rule: "migrations", key, message });
  const journal = JSON.parse(
    readFileSync(join(dir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql"));
  const tags = new Set(journal.entries.map((entry) => entry.tag));
  let previous = Number.NEGATIVE_INFINITY;
  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      add(
        entry.tag,
        `journal entry ${entry.tag} has idx ${entry.idx}, expected ${position}`,
      );
    }
    if (
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      Number(entry.tag.slice(0, 4)) !== position
    ) {
      add(
        entry.tag,
        `migration ${entry.tag} must be named ${String(position).padStart(4, "0")}_<snake_case>`,
      );
    }
    if (!files.includes(`${entry.tag}.sql`)) {
      add(entry.tag, `journal entry ${entry.tag} has no ${entry.tag}.sql`);
    }
    if (!(entry.when > previous)) {
      add(
        entry.tag,
        `journal entry ${entry.tag} has when=${entry.when}, not above the previous entry's ${previous}: drizzle would silently skip it (set it above the previous one)`,
      );
    }
    previous = entry.when;
  });
  for (const file of files) {
    if (!tags.has(file.replace(/\.sql$/, ""))) {
      add(
        file,
        `${file} has no journal entry (generate migrations with drizzle-kit generate)`,
      );
    }
  }
  return offences;
}

// ---------------------------------------------------------------- workflows
export function checkWorkflows(schema: string, handlers: string) {
  const offences: Offence[] = [];
  const union = schema.slice(schema.indexOf("export const WorkflowRequest"));
  const declared = new Set(
    [
      ...union
        .slice(0, union.indexOf("\n);"))
        .matchAll(/Literal\("([a-z0-9-]+)"\)/g),
    ].map((match) => match[1]!),
  );
  const handled = new Set(
    [...handlers.matchAll(/case "([a-z0-9-]+)":/g)].map((match) => match[1]!),
  );
  for (const name of declared) {
    if (!handled.has(name)) {
      offences.push({
        rule: "workflows",
        key: name,
        message: `workflow "${name}" is declared in packages/jobs/src/schema.ts but has no case in packages/jobs/src/workflows.ts`,
      });
    }
  }
  for (const name of handled) {
    if (!declared.has(name)) {
      offences.push({
        rule: "workflows",
        key: name,
        message: `workflows.ts handles "${name}", which is not in the WorkflowRequest union in schema.ts`,
      });
    }
  }
  return offences;
}

// ------------------------------------------------------------------- routes
const SEGMENT =
  /^([a-z0-9]+(-[a-z0-9]+)*|\[[a-zA-Z]+\]|\[\.\.\.[a-zA-Z]+\]|\([a-z-]+\))$/;

export function checkRoutes(appFiles: string[]) {
  const offences: Offence[] = [];
  for (const path of appFiles) {
    const inApp = path.replace(/^apps\/dashboard\/src\/app\//, "");
    const segments = inApp.split("/").slice(0, -1);
    const file = inApp.split("/").pop()!;
    const add = (message: string) =>
      offences.push({ rule: "routes", key: path, message });
    for (const segment of segments) {
      if (!SEGMENT.test(segment)) {
        add(
          `${path}: route segment "${segment}" must be kebab-case, [param] or (group)`,
        );
      }
    }
    if (/^page\.tsx?$/.test(file)) {
      if (!/^\[locale\]\/\((app|public)\)\//.test(inApp)) {
        add(
          `${path}: dashboard pages live under [locale]/(app) (signed in) or [locale]/(public)`,
        );
      }
    }
    if (/^route\.tsx?$/.test(file) && !inApp.startsWith("api/")) {
      add(`${path}: route handlers live under apps/dashboard/src/app/api`);
    }
  }
  return offences;
}

// ----------------------------------------------------------- provider-hosts
export const PROVIDER_HOSTS: {
  host: RegExp;
  label: string;
  adapters: RegExp;
}[] = [
  {
    host: /api\.typesafe\.ai/,
    label: "TypeSafe",
    adapters: /^packages\/documents\/src\/typesafe\//,
  },
  {
    host: /(api|identity|login)\.xero\.com/,
    label:
      "Xero (reach it through the Nango proxy in packages/jobs/src/nango.ts)",
    adapters: /^$/,
  },
  {
    host: /(sandbox-)?quickbooks\.api\.intuit\.com|oauth\.platform\.intuit\.com/,
    label:
      "QuickBooks (reach it through the Nango proxy in packages/jobs/src/nango.ts)",
    adapters: /^$/,
  },
  {
    host: /(www\.)?saltedge\.com\/api/,
    label: "Salt Edge (only its adapter packages/jobs/src/salt-edge.ts)",
    adapters: /^packages\/jobs\/src\/salt-edge\.ts$/,
  },
];

export function checkProviderHosts(files: { path: string; text: string }[]) {
  const offences: Offence[] = [];
  for (const { path, text } of files) {
    if (
      isTestFile(path) ||
      path.startsWith("scripts/") ||
      path.startsWith("e2e/")
    ) {
      continue;
    }
    for (const provider of PROVIDER_HOSTS) {
      if (provider.host.test(text) && !provider.adapters.test(path)) {
        offences.push({
          rule: "provider-hosts",
          key: path,
          message: `${path} names the ${provider.label} API host; only its adapter may`,
        });
      }
    }
  }
  return offences;
}

// -------------------------------------------------------------------- main
export const parseAllowlist = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

export function collectOffences(root = ROOT): Offence[] {
  const files = sourceFiles(root).map((path) => ({
    path,
    text: readFileSync(join(root, path), "utf8"),
  }));
  const dashboardApp = join(root, "apps", "dashboard", "src", "app");
  const appFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^(page|route)\.tsx?$/.test(entry.name)) {
        appFiles.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  walk(dashboardApp);
  return [
    ...checkDbAccess(files),
    ...checkMoneyColumns(
      readFileSync(join(root, "packages/db/src/schema.ts"), "utf8"),
    ),
    ...checkMigrations(join(root, "packages", "db", "migrations")),
    ...checkWorkflows(
      readFileSync(join(root, "packages/jobs/src/schema.ts"), "utf8"),
      readFileSync(join(root, "packages/jobs/src/workflows.ts"), "utf8"),
    ),
    ...checkRoutes(appFiles),
    ...checkProviderHosts(files),
  ];
}

function baseAllowlist(): string[] | null {
  for (const ref of ["origin/main", "main"]) {
    const base = git(["merge-base", "HEAD", ref])?.trim();
    if (!base) continue;
    const text = git(["show", `${base}:${ALLOWLIST}`]);
    return text === null ? null : parseAllowlist(text);
  }
  console.warn(
    `[warn] no origin/main or main; the ${ALLOWLIST} only-shrinks rule was not checked`,
  );
  return null;
}

if (import.meta.main) {
  const offences = collectOffences();
  if (process.argv.includes("--print-offenders")) {
    for (const offence of offences)
      console.log(`${offence.rule} ${offence.key}`);
    process.exit(0);
  }
  const listPath = join(ROOT, ALLOWLIST);
  const allowed = existsSync(listPath)
    ? parseAllowlist(readFileSync(listPath, "utf8"))
    : [];
  const allowedSet = new Set(allowed);
  const errors = offences
    .filter((offence) => !allowedSet.has(`${offence.rule} ${offence.key}`))
    .map((offence) => `[${offence.rule}] ${offence.message}`);
  const base = baseAllowlist();
  if (base !== null) {
    const baseSet = new Set(base);
    for (const entry of allowed) {
      if (!baseSet.has(entry)) {
        errors.push(
          `${ALLOWLIST} gained "${entry}": the allowlist may only shrink; follow docs/paved-path.md instead`,
        );
      }
    }
  }
  const live = new Set(
    offences.map((offence) => `${offence.rule} ${offence.key}`),
  );
  for (const entry of allowed) {
    if (!live.has(entry)) {
      console.warn(`[warn] ${ALLOWLIST}: "${entry}" is fixed; remove the line`);
    }
  }
  if (errors.length > 0) {
    console.error("Paved-path violations (docs/paved-path.md):");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `paved path ok: 6 rules, ${allowed.length} allowlisted existing offenders`,
  );
}
