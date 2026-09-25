import { Cause, Effect, Exit } from "effect";
import type { AuthorizationLine } from "../authorization-source";
import {
  SOURCE_MATCH_LIMITS,
  type SourceSemanticJudgment,
} from "../source-matching";
import { TypeSafe, TypeSafeError, TypeSafeLive } from "./client";

/** What TypeSafe is shown of one candidate source (never another workspace's). */
export type SemanticSourceCandidate = {
  sourceId: string;
  type: string;
  reference: string;
  title: string | null;
  scope: string | null;
  supplierName: string | null;
  currency: string | null;
  startsOn: string | null;
  endsOn: string | null;
  authorizedTotal: string;
  lines: readonly AuthorizationLine[];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const NONE = "none";
const optionId = (index: number) => `source_${index}`;

/** The invoice as the judgment reads it: what was billed, not how it was read. */
const invoiceState = (extraction: unknown) => {
  const record = asRecord(extraction);
  const lines = Array.isArray(record.lineItems) ? record.lineItems : [];
  return {
    documentType: record.documentType ?? null,
    supplierName: record.supplierName ?? null,
    invoiceNumber: record.invoiceNumber ?? null,
    invoiceDate: record.invoiceDate ?? null,
    currency: record.currency ?? null,
    netAmount: record.netAmount ?? null,
    grossAmount: record.grossAmount ?? null,
    description: record.description ?? null,
    purchaseOrderReference: record.purchaseOrderReference ?? null,
    lineItems: lines.slice(0, SOURCE_MATCH_LIMITS.judgmentLines).map((line) => {
      const item = asRecord(line);
      return {
        description: item.description ?? null,
        quantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        total: item.total ?? null,
      };
    }),
  };
};

const describeCandidate = (candidate: SemanticSourceCandidate) => ({
  kind:
    candidate.type === "purchase_order"
      ? "purchase order"
      : candidate.type === "contract"
        ? "contract"
        : "job",
  reference: candidate.reference,
  title: candidate.title,
  scope: candidate.scope,
  supplier: candidate.supplierName,
  currency: candidate.currency,
  period: { starts: candidate.startsOn, ends: candidate.endsOn },
  authorizedTotal: candidate.authorizedTotal,
  authorizedLines: candidate.lines
    .slice(0, SOURCE_MATCH_LIMITS.candidateLines)
    .map((line) => ({
      description: line.description,
      quantity: line.quantity,
      amount: line.amount,
    })),
});

/**
 * Asks TypeSafe which of the candidate sources the invoiced work falls under,
 * or none of them. It selects among the options given; it never names a
 * source of its own. A failure is returned as a result, not thrown, so the
 * caller records the invoice as lacking evidence rather than guessing.
 */
export const judgeSourceCandidates = (
  extraction: unknown,
  candidates: readonly SemanticSourceCandidate[],
): Effect.Effect<SourceSemanticJudgment, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const typeSafe = yield* TypeSafe;
    const options = candidates.map((candidate, index) => ({
      id: optionId(index),
      candidate,
    }));
    const response = yield* typeSafe.evaluate({
      state: { invoice: invoiceState(extraction) },
      questions: {
        authorized_source: {
          type: "choice",
          instructions:
            "Which of the authorized jobs, purchase orders or contracts does this invoice bill work under? Compare what the invoice charges for (its description and line items, dates and supplier) with each source's title, scope, authorized lines, supplier and period. Choose a source only when the invoiced work clearly falls within it. Choose 'none' when no source covers the work, or when the supplier alone is the only connection.",
          criteria: {
            ...Object.fromEntries(
              options.map(({ id, candidate }) => [
                id,
                describeCandidate(candidate),
              ]),
            ),
            [NONE]: "None of these sources covers the invoiced work.",
          },
        },
      },
    });
    const answer = response.answers.authorized_source;
    if (!answer || answer.type !== "choice") {
      return {
        status: "failed",
        reason: "TypeSafe did not answer the source question",
      } satisfies SourceSemanticJudgment;
    }
    const probabilityOf = (id: string) => {
      const value = answer.probabilities[id];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      // A response without probabilities still names its choice.
      return answer.choice === id ? answer.confidence : 0;
    };
    return {
      status: "answered",
      model: response.model,
      probabilities: Object.fromEntries(
        options.map(({ id, candidate }) => [
          candidate.sourceId,
          probabilityOf(id),
        ]),
      ),
      none: probabilityOf(NONE),
    } satisfies SourceSemanticJudgment;
  });

export type SourceJudge = (
  extraction: unknown,
  candidates: readonly SemanticSourceCandidate[],
) => Promise<
  | SourceSemanticJudgment
  | { status: "unavailable"; reason: string; retryable: boolean }
>;

/**
 * The production judge: TypeSafe from `TYPESAFE_*` configuration. A provider
 * failure comes back as `unavailable` with whether a retry can help.
 */
export const judgeSourceCandidatesLive: SourceJudge = async (
  extraction,
  candidates,
) => {
  const exit = await Effect.runPromiseExit(
    judgeSourceCandidates(extraction, candidates).pipe(
      Effect.provide(TypeSafeLive),
    ),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some" && failure.value instanceof TypeSafeError) {
    return {
      status: "unavailable",
      reason: failure.value.reason,
      retryable: failure.value.retryable,
    };
  }
  return {
    status: "unavailable",
    reason:
      failure._tag === "Some"
        ? "TypeSafe is not configured"
        : "TypeSafe is unavailable",
    retryable: failure._tag !== "Some",
  };
};
