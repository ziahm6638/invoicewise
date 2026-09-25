/**
 * Test policy (run by `bun run lint`): e2e journeys against the running app
 * are the gate, types and lint are the floor, and unit tests are not kept.
 *
 * Fails when:
 *   - a `*.test.*` or `*.spec.*` file exists outside `e2e/` and `invariants/`
 *     and is not a listed legacy file in `.test-policy-legacy.txt`;
 *   - `invariants/` holds more than 10 files, or one does not open with a
 *     `// Guards: <the real failure it guards>` line;
 *   - `.test-policy-legacy.txt` lists a path that the base branch's copy of
 *     the list (merge-base with origin/main) does not: the list only shrinks.
 * Listed legacy files that no longer exist only warn (deleted is good).
 *
 *   bun scripts/check-test-locations.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const LEGACY_LIST = ".test-policy-legacy.txt";
export const MAX_INVARIANTS = 10;
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED =
  /(^|\/)(node_modules|\.next|dist|build|coverage|\.turbo|\.verify-artifacts|\.wrangler|storybook-static|graft)\//;

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
};

/** Tracked plus untracked-but-not-ignored files, repository-relative. */
function repositoryFiles() {
  const tracked = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (tracked === null) throw new Error("git ls-files failed");
  return tracked
    .split("\n")
    .filter(Boolean)
    .filter((path) => existsSync(join(ROOT, path)))
    .filter((path) => !IGNORED.test(path));
}

export const parseList = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

/** The legacy list on the base branch, or null when the base has none. */
function baseList(): string[] | null {
  for (const ref of ["origin/main", "main"]) {
    const base = git(["merge-base", "HEAD", ref])?.trim();
    if (!base) continue;
    const text = git(["show", `${base}:${LEGACY_LIST}`]);
    return text === null ? null : parseList(text);
  }
  console.warn(
    `[warn] no origin/main or main to compare ${LEGACY_LIST} against; the only-shrinks rule was not checked`,
  );
  return null;
}

export function checkTestLocations(input: {
  files: string[];
  legacy: string[];
  base: string[] | null;
  readFirstLine: (path: string) => string;
}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const legacy = new Set(input.legacy);
  const files = new Set(input.files);

  for (const path of input.files) {
    if (!TEST_FILE.test(path)) continue;
    if (path.startsWith("e2e/") || path.startsWith("invariants/")) continue;
    if (!legacy.has(path)) {
      errors.push(
        `${path}: unit tests are not accepted. Cover the behaviour with an e2e journey (e2e/journeys/*.journey.ts); a genuine invariant goes in invariants/ with a "// Guards:" line`,
      );
    }
  }

  const invariants = input.files.filter((path) =>
    path.startsWith("invariants/"),
  );
  if (invariants.length > MAX_INVARIANTS) {
    errors.push(
      `invariants/ holds ${invariants.length} files; at most ${MAX_INVARIANTS} are allowed`,
    );
  }
  for (const path of invariants) {
    if (!/^\/\/ Guards: \S.*/.test(input.readFirstLine(path))) {
      errors.push(
        `${path}: must open with a one-line "// Guards: <the real failure it guards>" comment`,
      );
    }
  }

  if (input.base !== null) {
    const base = new Set(input.base);
    for (const path of input.legacy) {
      if (!base.has(path)) {
        errors.push(
          `${LEGACY_LIST} gained ${path}: the legacy list may only shrink`,
        );
      }
    }
  }
  for (const path of input.legacy) {
    if (!files.has(path)) {
      warnings.push(
        `${LEGACY_LIST} lists ${path}, which no longer exists: remove the line`,
      );
    }
  }
  return { errors, warnings };
}

if (import.meta.main) {
  const listPath = join(ROOT, LEGACY_LIST);
  const legacy = existsSync(listPath)
    ? parseList(readFileSync(listPath, "utf8"))
    : [];
  const { errors, warnings } = checkTestLocations({
    files: repositoryFiles(),
    legacy,
    base: baseList(),
    readFirstLine: (path) =>
      readFileSync(join(ROOT, path), "utf8").split("\n", 1)[0] ?? "",
  });
  for (const warning of warnings) console.warn(`[warn] ${warning}`);
  if (errors.length > 0) {
    console.error("Test policy violations:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(
    `test policy ok: ${legacy.length} legacy test files awaiting retirement`,
  );
}
