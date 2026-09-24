import { Effect, Layer } from "effect";
import {
  TypeSafe,
  type TypeSafeAnswer,
  type TypeSafeQuestion,
} from "../typesafe/client";

export type OracleRequest = {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
};

/**
 * A deterministic TypeSafe that answers like a correct model would: for each
 * field it selects the candidate whose value is the expected one (or absent
 * when none is), and confirms every table row. The assertions therefore test
 * everything code owns: reading, layout, candidate coverage, normalisation and
 * copying the selected values into the extraction.
 */
export const oracle = (
  expected: Record<string, unknown>,
  requests: OracleRequest[] = [],
) =>
  Layer.succeed(TypeSafe, {
    evaluate: (request) => {
      requests.push(request);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type === "noul") {
            return [id, { type: "noul", noul: 0.99 }];
          }
          const criteria = question.criteria as Record<string, any>;
          const choice =
            Object.entries(criteria).find(
              ([, criterion]) =>
                criterion?.value !== undefined &&
                criterion.value === expected[id],
            )?.[0] ?? "absent";
          return [
            id,
            { type: "choice", choice, probabilities: {}, confidence: 0.99 },
          ];
        }),
      ) as Record<string, TypeSafeAnswer>;
      return Effect.succeed({
        model: "test",
        answers,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  });
