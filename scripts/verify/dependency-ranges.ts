/**
 * Narrow, exact dependency-range validation.
 *
 * `manypkg check` still runs natively for every other rule, with the
 * `EXTERNAL_MISMATCH` rule configured off. That rule is replaced here by a
 * stricter check: the installed manypkg CLI runs over a probe copy of the
 * current manifests (with the waiver removed) and its mismatches must exactly
 * match the reviewed exceptions in `dependency-range-exceptions.json`. A new or
 * changed mismatch fails the gate, so a blanket ignore cannot hide drift.
 *
 * Nothing is upgraded or rewritten: incompatible runtime ranges (zod v4, 0.x
 * Polar) stay as they are and are recorded with a reason.
 */

import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, type Verification } from "./lib";

const EXCEPTIONS_PATH = join(
  ROOT,
  "scripts",
  "verify",
  "dependency-range-exceptions.json",
);

export type RangeMismatch = {
  workspace: string;
  dependency: string;
  range: string;
  mostCommonRange: string;
};

export type RangeException = RangeMismatch & { reason: string };

/** ANSI escape sequence used by the manypkg CLI output. */
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const stripAnsi = (line: string) => line.replace(ansiPattern, "");

const stripPrefix = (line: string) =>
  stripAnsi(line)
    .replace(/^\S+\s+/, "")
    .trim();

const MISMATCH_PATTERN =
  /^error (\S+) has a dependency on (.+)@(.+) but the most common range in the repo is (.+), the range should be set to .+$/;

/** Extracts EXTERNAL_MISMATCH findings from `manypkg check` output. */
export function parseMismatches(output: string): RangeMismatch[] {
  const mismatches: RangeMismatch[] = [];
  for (const rawLine of output.split("\n")) {
    const line = stripPrefix(rawLine);
    const match = line.match(MISMATCH_PATTERN);
    if (!match) continue;
    const [, workspace, dependency, range, mostCommonRange] = match;
    mismatches.push({
      workspace: workspace!,
      dependency: dependency!,
      range: range!,
      mostCommonRange: mostCommonRange!,
    });
  }
  return mismatches;
}

const keyOf = (mismatch: RangeMismatch) =>
  `${mismatch.workspace}|${mismatch.dependency}|${mismatch.range}|${mismatch.mostCommonRange}`;

export function diffMismatches(
  found: RangeMismatch[],
  exceptions: RangeException[],
) {
  const allowed = new Set(exceptions.map(keyOf));
  const seen = new Set(found.map(keyOf));
  return {
    unexpected: found.filter((mismatch) => !allowed.has(keyOf(mismatch))),
    missing: exceptions.filter((exception) => !seen.has(keyOf(exception))),
  };
}

export async function loadRangeExceptions(): Promise<RangeException[]> {
  const file = (await Bun.file(EXCEPTIONS_PATH).json()) as {
    exceptions: RangeException[];
  };
  return file.exceptions;
}

/** Copies the current manifests (and lockfile) so manypkg can judge ranges. */
export async function buildRangeProbe(
  rootDir: string,
  probeDir: string,
): Promise<string> {
  const rawRootManifest = (await Bun.file(
    join(rootDir, "package.json"),
  ).json()) as {
    workspaces?: string[];
    manypkg?: unknown;
  };
  // `undefined` is dropped by JSON.stringify, so the probe manifest carries no
  // `manypkg` field and the EXTERNAL_MISMATCH waiver does not apply there.
  const rootManifest = { ...rawRootManifest, manypkg: undefined };

  await mkdir(probeDir, { recursive: true });
  await Bun.write(
    join(probeDir, "package.json"),
    `${JSON.stringify(rootManifest, null, 2)}\n`,
  );
  await copyFile(join(rootDir, "bun.lock"), join(probeDir, "bun.lock"));

  const workspaceDirs = ["apps", "packages", "packages/email"];
  for (const parent of workspaceDirs) {
    let entries: string[];
    try {
      entries = await readdir(join(rootDir, parent));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const source = join(rootDir, parent, entry, "package.json");
      if (!(await Bun.file(source).exists())) continue;
      const target = join(probeDir, parent, entry, "package.json");
      await mkdir(join(probeDir, parent, entry), { recursive: true });
      await copyFile(source, target);
    }
  }
  return probeDir;
}

export async function runDependencyRangeCheck(
  v: Verification,
  runEnv: Record<string, string>,
  rootDir: string,
  probeDir: string,
) {
  const probe = await buildRangeProbe(rootDir, probeDir);
  const result = await v.runStep("hygiene:dependency-range-probe", {
    command: "bun",
    args: ["--no-env-file", "x", "manypkg", "check"],
    cwd: probe,
    env: runEnv,
    allowFailure: true,
    timeoutMs: 5 * 60 * 1000,
  });

  await v.requireCheck("hygiene:dependency-ranges-exact", async () => {
    const output = result.output;
    if (!/workspaces valid|has a dependency on/.test(output)) {
      throw new Error(
        `dependency-range probe did not run to completion; see ${result.logPath}`,
      );
    }

    const errorLines = output
      .split("\n")
      .map((line) => stripAnsi(line).trim())
      .filter((line) => line.includes("☔️ error"));
    const otherErrors = errorLines.filter(
      (line) => !MISMATCH_PATTERN.test(stripPrefix(line)),
    );
    if (otherErrors.length > 0) {
      throw new Error(
        `unexpected workspace hygiene errors in the probe:\n${otherErrors.join("\n")}`,
      );
    }

    const found = parseMismatches(output);
    const exceptions = await loadRangeExceptions();
    const { unexpected, missing } = diffMismatches(found, exceptions);

    if (unexpected.length > 0) {
      throw new Error(
        `new or changed dependency-range mismatches (review and record them explicitly in scripts/verify/dependency-range-exceptions.json):\n${unexpected
          .map(
            (mismatch) =>
              `  ${mismatch.workspace} | ${mismatch.dependency} | ${mismatch.range} (repo default ${mismatch.mostCommonRange})`,
          )
          .join("\n")}`,
      );
    }
    if (missing.length > 0) {
      throw new Error(
        `recorded dependency-range exceptions are stale (remove them deliberately):\n${missing
          .map(
            (exception) =>
              `  ${exception.workspace} | ${exception.dependency} | ${exception.range}`,
          )
          .join("\n")}`,
      );
    }

    return `${found.length} dependency-range mismatches, all reviewed exceptions; no unreviewed drift`;
  });
}
