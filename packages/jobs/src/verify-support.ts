/**
 * Shared fixtures for the DB-backed verifiers: a TypeSafe stub that answers
 * like a correct model for the committed synthetic invoices.
 */

import type { Database } from "@invoicewise/db/client";
import { DEFAULT_DELIVERY_POLICY } from "@invoicewise/documents";
import { saveDeliveryPolicy } from "./delivery-rules";

/**
 * For a verifier that proves a later guarantee (the accounting job's own
 * claims, the processing handoff) with fixtures that reuse one date and
 * total across invoice numbers: the delivery rules' possible-duplicate hold
 * would stop them before they reach what is being proved. Every other rule
 * keeps its default.
 */
export const deliverPossibleDuplicates = (db: Database, teamId: string) =>
  saveDeliveryPolicy(db, {
    teamId,
    actorId: null,
    teamRole: "owner",
    expectedVersion: 0,
    settings: {
      ...DEFAULT_DELIVERY_POLICY,
      rules: {
        ...DEFAULT_DELIVERY_POLICY.rules,
        possible_duplicate: "deliver",
      },
    },
  });

export const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

// What a correct model selects for each field of the synthetic fixture. The
// stub can only choose among the candidates the pipeline found in the PDF, so
// the persisted extraction proves the real reading, layout and candidate
// mining end to end.
const extractionValues: Record<string, string | number> = {
  document_type: "invoice",
  supplier_name: "ACME SUPPLIES LTD",
  supplier_address: "10 Market Street, London, EC1A 1AA",
  supplier_vat_number: "GB123456789",
  invoice_number: "INV-2026-0042",
  invoice_date: "2026-09-01",
  due_date: "2026-09-30",
  currency: "GBP",
  net_amount: 1000,
  vat_amount: 200,
  gross_amount: 1200,
  bank_account_name: "ACME SUPPLIES LTD",
  bank_account_number: "12345678",
  bank_sort_code: "12-34-56",
  bank_iban: "GB12 ACME 1234 5678 9012 34",
  bank_bic: "ACMEGB2L",
  description: "September consulting services",
  purchase_order_reference: "PO-7788",
};

// The same selections for the UK invoice fixture, which the input-matrix
// phase uploads as a text PDF, a scanned PDF, a PNG scan and a JPEG photo.
const ukInvoiceValues: Record<string, string | number> = {
  document_type: "invoice",
  supplier_name: "Northwind Joinery Ltd",
  supplier_address: "Unit 4, Riverside Trading Estate, Leeds, LS11 5QP",
  supplier_vat_number: "GB293445512",
  invoice_number: "NJ-10457",
  invoice_date: "1 September 2026",
  due_date: "01-Oct-2026",
  currency: "GBP",
  net_amount: 2161,
  vat_amount: 432.2,
  gross_amount: 2593.2,
  bank_account_name: "Northwind Joinery Ltd",
  bank_account_number: "71234598",
  bank_sort_code: "40-11-62",
  bank_iban: "GB29 NWBK 6016 1331 9268 19",
  bank_bic: "NWBKGB2L",
  purchase_order_reference: "PO-55120",
};

/**
 * Which document the stub is reading. A non-invoice gets no selections, so
 * every field is "absent", as a correct model would answer.
 */
const selectionsFor = (state: unknown): Record<string, string | number> => {
  const invoice = JSON.stringify(state);
  if (invoice.includes("Northwind")) {
    return invoice.includes("change of address") ? {} : ukInvoiceValues;
  }
  return extractionValues;
};

const extractionAnswers = (
  questions: Record<string, any>,
  selections: Record<string, string | number>,
) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (id.startsWith("line_item_")) {
        return [id, { type: "noul", noul: 0.99 }];
      }
      const choice =
        Object.entries(question.criteria).find(
          ([, criterion]: [string, any]) => criterion?.value === selections[id],
        )?.[0] ?? "absent";
      return [
        id,
        { type: "choice", choice, probabilities: {}, confidence: 0.99 },
      ];
    }),
  );

const judgmentAnswers = (questions: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const instructions = JSON.stringify(question.instructions).toLowerCase();
      if (instructions.includes("cost centre")) {
        return [id, { type: "noul", noul: 0.5 }];
      }
      if (question.type === "choice") {
        return [
          id,
          {
            type: "choice",
            choice: "option_0",
            probabilities: { option_0: 0.9, option_1: 0.1 },
            confidence: 0.8,
          },
        ];
      }
      if (question.type === "score") {
        return [
          id,
          {
            type: "score",
            score: 0.8,
            legend: { "0": "Low", "1": "High" },
            probabilities: { "0": 0.2, "1": 0.8 },
            confidence: 0.6,
          },
        ];
      }
      return [id, { type: "noul", noul: 0.94 }];
    }),
  );

export const startTypeSafeStub = () =>
  Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        state: unknown;
        questions: Record<string, any>;
      };
      const isExtraction = Object.keys(body.questions).some(
        (id) =>
          Object.hasOwn(extractionValues, id) || id.startsWith("line_item_"),
      );
      const answers = isExtraction
        ? extractionAnswers(body.questions, selectionsFor(body.state))
        : judgmentAnswers(body.questions);
      return Response.json({
        model: "verification-stub",
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    },
  });
