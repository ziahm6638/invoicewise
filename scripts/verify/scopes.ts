/**
 * Product-scope boundaries used by the verification command.
 *
 * The retired bank/transaction matching suites are not part of the product and
 * are excluded from the package `test` script, but they still run so the
 * recorded failure set is real evidence. A crashed or unparseable run must fail
 * the gate instead of being read as "zero failures".
 */

export const RETIRED_MATCHING_EXPECTED_FAILURES = [
  "Cross-Currency Matching Algorithm > Tiered Tolerance System > should use 8% tolerance for small amounts (<100)",
  "Cross-Currency Matching Algorithm > Tiered Tolerance System > should use 5% tolerance for medium amounts (100-1000)",
  "Cross-Currency Matching Algorithm > Tiered Tolerance System > should use 3% tolerance for large amounts (>1000)",
] as const;

export function parseRetiredMatchingOutcome(
  output: string,
  expectedFailures: readonly string[] = RETIRED_MATCHING_EXPECTED_FAILURES,
) {
  const completed = /\bRan \d+ tests? across \d+ files?\b/.test(output);
  if (!completed) {
    return {
      ok: false as const,
      reason:
        "the retired matching suite did not report a completed run (crashed, missing tooling or interrupted)",
    };
  }
  const failures = new Set(
    (output.match(/^\(fail\) .*$/gm) ?? []).map((line) =>
      line.replace(/^\(fail\) /, "").replace(/ \[[\d.]+m?s\]$/, ""),
    ),
  );
  const expected = new Set(expectedFailures);
  const unexpected = [...failures].filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !failures.has(name));
  if (unexpected.length > 0 || missing.length > 0) {
    return {
      ok: false as const,
      reason: `retired bank-matching failures changed: unexpected [${unexpected.join("; ")}], no longer failing [${missing.join("; ")}]`,
    };
  }
  return { ok: true as const, failures: failures.size };
}
