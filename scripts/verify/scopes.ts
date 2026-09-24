/**
 * Product-scope boundaries used by the verification command.
 *
 * The retired bank/transaction matching suites are not part of the product and
 * are excluded from the package `test` script, but they still run so the
 * recorded failure set is real evidence. A crashed or unparseable run must fail
 * the gate instead of being read as "zero failures".
 */

export const RETIRED_MATCHING_EXPECTED_FAILURES = 3;

export function parseRetiredMatchingOutcome(
  output: string,
  expectedFailures = RETIRED_MATCHING_EXPECTED_FAILURES,
) {
  const completed = /\bRan \d+ tests? across \d+ files?\b/.test(output);
  if (!completed) {
    return {
      ok: false as const,
      reason:
        "the retired matching suite did not report a completed run (crashed, missing tooling or interrupted)",
    };
  }
  const failures = new Set(output.match(/^\(fail\) .*$/gm) ?? []).size;
  if (failures !== expectedFailures) {
    return {
      ok: false as const,
      reason: `retired bank-matching failures changed: ${failures} != recorded ${expectedFailures}`,
    };
  }
  return { ok: true as const, failures };
}
