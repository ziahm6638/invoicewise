/**
 * InvoiceWise e2e journeys against the running app: the project's gate.
 *
 *   bun run e2e                          # build, start, run every journey
 *   bun run e2e -- --journey intake      # only journeys whose id contains "intake"
 *   bun run e2e -- --parallel            # run the journeys concurrently
 *
 * Internal (used by `bun run gate`):
 *   --build-only <dir>   build into <dir> and write <dir>/manifest.json
 *   --prebuilt <dir>     run against that build instead of building again
 *
 * Needs the project's Postgres and Redis already running (docker compose or
 * the verification suite); see e2e/support/services.ts. Evidence lands in
 * ${E2E_EVIDENCE_ROOT:-~/e2e-evidence}/invoicewise/<run-id>/ and the last
 * line printed is `E2E_REPORT=<absolute path to report.md>`.
 */

import { useSharedServices } from "../e2e/support/services";

const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const only: string[] = [];
args.forEach((arg, index) => {
  if (arg === "--journey" && args[index + 1]) only.push(args[index + 1]!);
});

const services = useSharedServices();
// Imported only after the shared services are exported to the environment:
// the verification helpers read their targets at import time.
const { runE2E } = await import("../e2e/support/runner");

const code = await runE2E({
  services,
  buildOnly: flagValue("--build-only"),
  prebuilt: flagValue("--prebuilt"),
  only,
  parallel: args.includes("--parallel") || process.env.E2E_PARALLEL === "1",
});
process.exit(code);
