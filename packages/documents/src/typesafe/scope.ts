import { Cause, Effect, Exit } from "effect";
import type { AuthorizationLine } from "../authorization-source";
import type { ScopeJudgment } from "../reconciliation";
import { SOURCE_MATCH_LIMITS } from "../source-matching";
import { TypeSafe, TypeSafeError, TypeSafeLive } from "./client";

/** One invoice line to read against one source's written scope. */
export type ScopeQuestion = {
  key: string;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
  source: {
    type: string;
    reference: string;
    title: string | null;
    scope: string | null;
    lines: readonly AuthorizationLine[];
  };
};

const WITHIN = "within_scope";
const OUTSIDE = "outside_scope";
const UNCLEAR = "unclear";

const questionId = (index: number) => `line_${index}`;

/**
 * Asks TypeSafe, for each invoice line that pairs with no authorized line,
 * whether the work it bills falls within the source's written scope. It
 * chooses among three fixed answers; code decides what an answer means, and
 * no answer changes an amount. Only the invoice's own workspace's source is
 * shown. A failure is returned per line, not thrown.
 */
export const judgeScope = (
  questions: readonly ScopeQuestion[],
): Effect.Effect<Record<string, ScopeJudgment>, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    if (questions.length === 0) return {};
    const typeSafe = yield* TypeSafe;
    const response = yield* typeSafe.evaluate({
      state: {
        lines: questions.map((question, index) => ({
          id: questionId(index),
          invoiceLine: {
            description: question.description,
            quantity: question.quantity,
            unitPrice: question.unitPrice,
            total: question.total,
          },
          authorization: {
            kind: question.source.type.replace("_", " "),
            reference: question.source.reference,
            title: question.source.title,
            scope: question.source.scope,
            authorizedLines: question.source.lines
              .slice(0, SOURCE_MATCH_LIMITS.candidateLines)
              .map((line) => ({
                description: line.description,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
              })),
          },
        })),
      },
      questions: Object.fromEntries(
        questions.map((_, index) => [
          questionId(index),
          {
            type: "choice" as const,
            instructions: `For invoice line ${questionId(index)}: it matches none of the authorization's listed lines. Is the work or goods it bills within what the authorization's title, written scope and listed lines cover? Answer '${WITHIN}' only when the work plainly belongs to that authorized scope, '${OUTSIDE}' when it is different work, and '${UNCLEAR}' when the description is too vague to say.`,
            criteria: {
              [WITHIN]: "The line bills work within the authorized scope.",
              [OUTSIDE]: "The line bills work outside the authorized scope.",
              [UNCLEAR]: "It cannot be told from the descriptions.",
            },
          },
        ]),
      ),
    });
    return Object.fromEntries(
      questions.map((question, index) => {
        const answer = response.answers[questionId(index)];
        if (!answer || answer.type !== "choice") {
          return [
            question.key,
            {
              status: "failed",
              reason: "TypeSafe did not answer the scope question",
            } satisfies ScopeJudgment,
          ];
        }
        const choice =
          answer.choice === WITHIN || answer.choice === OUTSIDE
            ? answer.choice
            : UNCLEAR;
        const probability = answer.probabilities[answer.choice];
        return [
          question.key,
          {
            status: "answered",
            model: response.model,
            answer: choice,
            probability:
              typeof probability === "number" && Number.isFinite(probability)
                ? probability
                : answer.confidence,
          } satisfies ScopeJudgment,
        ];
      }),
    );
  });

export type ScopeJudge = (
  questions: readonly ScopeQuestion[],
) => Promise<
  | { status: "answered"; judgments: Record<string, ScopeJudgment> }
  | { status: "unavailable"; reason: string; retryable: boolean }
>;

/** The production judge: TypeSafe from `TYPESAFE_*` configuration. */
export const judgeScopeLive: ScopeJudge = async (questions) => {
  const exit = await Effect.runPromiseExit(
    judgeScope(questions).pipe(Effect.provide(TypeSafeLive)),
  );
  if (Exit.isSuccess(exit))
    return { status: "answered", judgments: exit.value };
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
