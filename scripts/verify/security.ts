/**
 * Local equivalents of the CI dependency and secret checks.
 *
 * Dependencies: `bun audit` is compared against a recorded inventory of known
 * advisories. New high/critical advisories fail the run. The inventory is
 * outstanding security debt tracked by the release issue (#62), not a release
 * clearance.
 *
 * Secrets: every candidate file (tracked plus untracked, non-ignored locally) is
 * scanned for high-confidence credential shapes. Exceptions are declared as
 * exact (path, value) fixture pairs, so a real-shaped credential cannot be
 * waived by a broad substring rule. Matches are reported by path, line and
 * pattern only; credential contents are never printed.
 */

import { statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, type Verification, redact } from "./lib";

export type AuditAdvisory = {
  id: number;
  url: string;
  title: string;
  severity: string;
};

const ADVISORY_BASELINE_PATH = join(
  ROOT,
  "scripts",
  "verify",
  "dependency-advisory-baseline.json",
);

export async function loadAdvisoryBaseline() {
  const baseline = await Bun.file(ADVISORY_BASELINE_PATH).json();
  return new Set<string>(baseline.advisories as string[]);
}

/**
 * High/critical advisories keyed by `<advisory id>|<package>`. Returning the
 * key set lets the caller diff against the recorded inventory.
 */
export function highSeverityAdvisoryKeys(
  auditJson: Record<string, AuditAdvisory[]>,
) {
  const keys: string[] = [];
  for (const [pkg, advisories] of Object.entries(auditJson)) {
    for (const advisory of advisories) {
      if (advisory.severity === "high" || advisory.severity === "critical") {
        keys.push(`${advisory.id}|${pkg}`);
      }
    }
  }
  return keys.sort();
}

type SecretPattern = { name: string; pattern: RegExp };

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "resend-key", pattern: /\bre_[A-Za-z0-9]{16,}\b/ },
  { name: "stripe-live-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "nango-secret", pattern: /\bnango_[A-Za-z0-9]{20,}\b/ },
  {
    name: "assigned-credential",
    pattern:
      /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{24,})["']?/i,
  },
  {
    name: "env-credential",
    pattern:
      /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*[:=]\s*["']?(?=[A-Za-z0-9_\-+/=.]*[a-z\-+/=])([A-Za-z0-9_\-+/=.]{16,})["']?/,
  },
];

/**
 * Exact, path-scoped exceptions for committed local templates and synthetic
 * fixtures. A value is only waived when both the path and the matched value
 * match exactly; everything else fails the gate.
 */
export const SECRET_EXCEPTIONS: {
  path: string;
  value: string;
  reason: string;
}[] = [
  {
    path: "apps/api/.env-template",
    value: "invoicewise-local-development-auth-secret-change-in-production",
    reason: "committed local template for the shared development auth secret",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "invoicewise-local-development-auth-secret-change-in-production",
    reason: "committed local template for the shared development auth secret",
  },
  {
    path: ".env.example",
    value: "local-development-storage-secret",
    reason:
      "committed local template for the development storage signing secret",
  },
  {
    path: "apps/api/.env-template",
    value: "local-development-storage-secret",
    reason:
      "committed local template for the development storage signing secret",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "local-development-storage-secret",
    reason:
      "committed local template for the development storage signing secret",
  },
  {
    path: "apps/api/.env-template",
    value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    reason: "committed local template for the development encryption key",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    reason: "committed local template for the development encryption key",
  },
  {
    path: ".env.example",
    value: "invoicewise-secret",
    reason: "committed local template for the development MinIO credential",
  },
  {
    path: "apps/api/.env-template",
    value: "invoicewise-secret",
    reason: "committed local template for the development MinIO credential",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "invoicewise-secret",
    reason: "committed local template for the development MinIO credential",
  },
  {
    path: "packages/jobs/.env-template",
    value: "invoicewise-secret",
    reason: "committed local template for the development MinIO credential",
  },
  {
    path: "docs/development.md",
    value: "invoicewise-secret",
    reason: "documented development MinIO credential",
  },
  {
    path: "packages/jobs/.env-template",
    value: "local-development-storage-secret",
    reason:
      "committed local template for the development storage signing secret",
  },
  {
    path: "docs/development.md",
    value: "local-development-storage-secret",
    reason: "documented development storage signing secret",
  },
  {
    path: "apps/api/.env-template",
    value: "re_local_development",
    reason: "committed local template placeholder for the Resend key",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "re_local_development",
    reason: "committed local template placeholder for the Resend key",
  },
  {
    path: "apps/api/.env-template",
    value: "polar_local_development",
    reason: "committed local template placeholder for the Polar token",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "polar_local_development",
    reason: "committed local template placeholder for the Polar token",
  },
  {
    path: "apps/dashboard/.env-example",
    value: "local-development-webhook-secret",
    reason: "committed local template for the development webhook secret",
  },
  {
    path: "scripts/verify/lib.ts",
    value: "invoicewise-verify-auth-secret-0123456789abcdef",
    reason: "synthetic verification auth secret",
  },
  {
    path: "scripts/verify/lib.ts",
    value: "invoicewise-verify-storage-signing-secret",
    reason: "synthetic verification storage signing secret",
  },
  {
    path: "scripts/verify/release.ts",
    value: "invoicewise-verify-storage-signing-secret",
    reason: "synthetic verification storage signing secret",
  },
  {
    path: "scripts/verify/lib.ts",
    value: "polar_verify_stub",
    reason: "synthetic verification provider stub",
  },
  {
    path: "scripts/verify/lib.ts",
    value: "nango_verify_stub",
    reason: "synthetic verification provider stub",
  },
  {
    path: "scripts/verify/verify-selftest.test.ts",
    value: "re_testabcdefghijklmnopqrst",
    reason: "synthetic scanner positive control (contains 'test')",
  },
  {
    path: "scripts/verify/verify-selftest.test.ts",
    value: "test_abcdefghijklmnopqrstuvwx",
    reason: "synthetic scanner positive control (contains 'test')",
  },
  {
    path: "scripts/verify/verify-selftest.test.ts",
    value: "re_liveabcdefghijklmnop",
    reason:
      "synthetic scanner control proving a template path does not waive an unlisted value",
  },
  {
    path: "scripts/verify/verify-selftest.test.ts",
    value: "re_liveabcdefghijklmnopqrst",
    reason:
      "synthetic scanner control proving a template path does not waive an unlisted value",
  },
  {
    path: "scripts/verify/verify-selftest.test.ts",
    value: "re_ABCDEFGHIJKLMNOPQRSTUV",
    reason: "synthetic scanner/redaction control value",
  },
  {
    path: "scripts/verify/security.ts",
    value: "re_testabcdefghijklmnopqrst",
    reason: "exception literal for the synthetic scanner control",
  },
  {
    path: "scripts/verify/security.ts",
    value: "test_abcdefghijklmnopqrstuvwx",
    reason: "exception literal for the synthetic scanner control",
  },
  {
    path: "scripts/verify/security.ts",
    value: "re_liveabcdefghijklmnop",
    reason: "exception literal for the synthetic scanner control",
  },
  {
    path: "scripts/verify/security.ts",
    value: "re_liveabcdefghijklmnopqrst",
    reason: "exception literal for the synthetic scanner control",
  },
  {
    path: "scripts/verify/security.ts",
    value: "re_ABCDEFGHIJKLMNOPQRSTUV",
    reason: "exception literal for the synthetic scanner/redaction control",
  },
];

const BINARY_OR_GENERATED_PATHS = [
  /^bun\.lock$/,
  /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|mp4|webp)$/i,
  /(^|\/)node_modules\//,
  /^\.verify-artifacts\//,
  /(^|\/)\.next\//,
  /(^|\/)\.turbo\//,
  /packages\/db\/migrations\/meta\//,
];

export type SecretHit = { path: string; line: number; pattern: string };

const isException = (path: string, value: string) =>
  SECRET_EXCEPTIONS.some(
    (exception) => exception.path === path && exception.value === value,
  );

/** Pure scanner used by both the gate and the negative-control tests. */
export function scanContentForSecrets(
  path: string,
  content: string,
): SecretHit[] {
  const hits: SecretHit[] = [];
  if (content.includes("\u0000")) return hits;
  const lines = content.split("\n");
  for (const { name, pattern } of SECRET_PATTERNS) {
    const matcher = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      for (const match of line.matchAll(matcher)) {
        const candidate = match[1] ?? match[0];
        if (isException(path, candidate)) continue;
        hits.push({ path, line: index + 1, pattern: name });
      }
    }
  }
  return hits;
}

/**
 * Running Git must never be optional: a failed or unavailable enumeration has
 * to fail the check instead of producing a silent zero-hit result.
 */
function gitList(root: string, args: string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `git ${args.join(" ")} failed in ${root} (exit ${result.exitCode}): ${
        redact(stderr).slice(0, 300) || "no stderr"
      }`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function candidateFiles(root = ROOT): string[] {
  const tracked = gitList(root, ["ls-files"]);
  const untracked = gitList(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  return [...new Set([...tracked, ...untracked])]
    .filter((file) => !BINARY_OR_GENERATED_PATHS.some((p) => p.test(file)))
    .sort();
}

export type SecretScanResult = {
  hits: SecretHit[];
  scanned: number;
  skippedBinary: string[];
};

/**
 * Scans an explicit file list. A listed path that is missing from the worktree
 * (an uncommitted deletion) or that cannot be read fails the scan instead of
 * being skipped.
 */
export async function scanFiles(
  root: string,
  files: string[],
): Promise<SecretScanResult> {
  const hits: SecretHit[] = [];
  const skippedBinary: string[] = [];
  let scanned = 0;

  for (const file of files) {
    const absolute = join(root, file);
    const handle = Bun.file(absolute);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      throw new Error(
        `${file} is listed by git but missing from the worktree; commit the deletion or restore the file before scanning`,
      );
    }
    if (!stats.isFile()) {
      throw new Error(
        `${file} is not a regular file (${stats.isDirectory() ? "directory" : "special file"}); the candidate list is inconsistent`,
      );
    }
    let content: string;
    try {
      content = await handle.text();
    } catch (error) {
      throw new Error(
        `could not read candidate file ${file}: ${redact(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
    if (content.includes("\u0000")) {
      skippedBinary.push(file);
      continue;
    }
    scanned += 1;
    hits.push(...scanContentForSecrets(relative(root, absolute), content));
  }

  return { hits, scanned, skippedBinary };
}

export async function scanRepository(root = ROOT): Promise<SecretScanResult> {
  return scanFiles(root, candidateFiles(root));
}

export async function runSecretScan(v: Verification) {
  await v.runCheck("security:repository-secret-scan", async () => {
    const { hits, scanned, skippedBinary } = await scanRepository();
    if (hits.length > 0) {
      throw new Error(
        `possible credentials in repository files (contents withheld):\n${hits
          .map((hit) => `  ${hit.path}:${hit.line} (${hit.pattern})`)
          .join("\n")}`,
      );
    }
    return `no high-confidence credential patterns in ${scanned} text files (${skippedBinary.length} binary candidates skipped by content; tracked + untracked; ${SECRET_EXCEPTIONS.length} exact fixture exceptions)`;
  });
}

export async function runDependencyCheck(
  v: Verification,
  runEnv: Record<string, string>,
) {
  const audit = await v.runStep("security:bun-audit", {
    command: "bun",
    args: ["--no-env-file", "audit", "--json"],
    cwd: ROOT,
    env: runEnv,
    allowFailure: true,
    timeoutMs: 5 * 60 * 1000,
  });

  await v.runCheck("security:dependency-advisories-vs-inventory", async () => {
    let parsed: Record<string, AuditAdvisory[]>;
    try {
      parsed = JSON.parse(audit.stdout) as Record<string, AuditAdvisory[]>;
    } catch {
      throw new Error(
        `could not read the audit report; see ${audit.logPath} (exit ${audit.exitCode})`,
      );
    }

    const recorded = await loadAdvisoryBaseline();
    const current = highSeverityAdvisoryKeys(parsed);
    const added = current.filter((key) => !recorded.has(key));
    const resolved = [...recorded].filter((key) => !current.includes(key));

    if (added.length > 0) {
      throw new Error(
        `new high/critical advisories (fix or record deliberately in scripts/verify/dependency-advisory-baseline.json):\n${added
          .map((key) => `  ${key}`)
          .join("\n")}`,
      );
    }
    return `${current.length} high/critical advisories, all in the recorded inventory (${resolved.length} recorded entries now resolved). Outstanding inventory is tracked by #62; this is not release security clearance.`;
  });
}
