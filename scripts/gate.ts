/**
 * The InvoiceWise gate: `bun run gate`. One command, four steps, stopping at
 * the first failure:
 *
 *   1. typecheck  turbo typecheck + the scripts/e2e tooling
 *   2. lint       biome, manypkg, feature map, paved path, test policy
 *   3. build      production builds of the dashboard, website, API and
 *                 worker in an isolated `.env`-free workspace
 *   4. e2e        the journeys in e2e/journeys against that build, running on
 *                 a per-run database (scripts/e2e.ts)
 *
 * Unit tests are not part of the gate (see docs/paved-path.md#tests). The
 * full log is written next to the e2e evidence, and the last line printed is
 * the e2e run's `E2E_REPORT=<report.md>`: link it in the PR's Evidence.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceRoot = join(
  process.env.E2E_EVIDENCE_ROOT ?? join(homedir(), "e2e-evidence"),
  "invoicewise",
);
mkdirSync(evidenceRoot, { recursive: true });
const logPath = join(evidenceRoot, `gate-${stamp}.log`);
const buildDir = join(ROOT, ".verify-artifacts", `gate-build-${stamp}`);

const log = (text: string) => {
  process.stdout.write(text);
  appendFileSync(logPath, text);
};

async function step(name: string, cmd: string[]) {
  const started = Date.now();
  log(`\n=== gate: ${name} (${cmd.join(" ")})\n`);
  const child = Bun.spawn({
    cmd,
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      log(text);
    }
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  const code = await child.exited;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `=== gate: ${name} ${code === 0 ? "passed" : `FAILED (exit ${code})`} in ${seconds}s\n`,
  );
  return { code, output };
}

let failed: string | undefined;
let report: string | undefined;
try {
  for (const [name, cmd] of [
    ["typecheck", ["bun", "run", "typecheck"]],
    ["lint", ["bun", "run", "lint"]],
    [
      "build",
      ["bun", "--no-env-file", "scripts/e2e.ts", "--build-only", buildDir],
    ],
    ["e2e", ["bun", "--no-env-file", "scripts/e2e.ts", "--prebuilt", buildDir]],
  ] as const) {
    const result = await step(name, [...cmd]);
    report = result.output.match(/^E2E_REPORT=(.+)$/m)?.[1] ?? report;
    if (result.code !== 0) {
      failed = name;
      break;
    }
  }
} finally {
  await rm(buildDir, { recursive: true, force: true });
}

log(
  `\n${failed ? `GATE FAILED at ${failed}` : "GATE PASSED"}: full log ${logPath}\n`,
);
if (report) log(`E2E_REPORT=${report}\n`);
process.exit(failed ? 1 : 0);
