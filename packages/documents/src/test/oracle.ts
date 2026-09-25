import { Effect, Layer } from "effect";
import {
  TypeSafe,
  type TypeSafeAnswer,
  type TypeSafeQuestion,
} from "../typesafe/client";
import type { InvoiceLineItem } from "../typesafe/line-items";

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

/** An extraction's values without their evidence, for comparing field values. */
export const fieldsOf = <T extends { evidence?: unknown }>(extraction: T) => {
  const { evidence: _evidence, ...fields } = extraction;
  return fields;
};

/** A line item with the columns its table does not print left null. */
export const lineItem = (
  value: Partial<InvoiceLineItem> &
    Pick<InvoiceLineItem, "description" | "total">,
): InvoiceLineItem => ({
  quantity: null,
  unitPrice: null,
  discountAmount: null,
  discountRate: null,
  taxRate: null,
  taxAmount: null,
  ...value,
});

/** The fields added for validation, as an extraction without them reads. */
export const NOT_FOUND = {
  documentType: null,
  supplierCompanyNumber: null,
  originalInvoiceNumber: null,
  discountAmount: null,
  taxRate: null,
  amountsIncludeTax: null,
  paymentReference: null,
} as const;
