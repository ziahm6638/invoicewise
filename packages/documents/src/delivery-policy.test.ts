import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DELIVERY_POLICY,
  DELIVERY_POLICY_LIMITS,
  type DeliveryPolicy,
  type PolicyQuestion,
  evaluateDeliveryPolicy,
  normalizeDeliveryPolicy,
  releasable,
} from "./delivery-policy";

const validValidation = {
  version: 1,
  status: "valid",
  documentType: "invoice",
  totals: { gross: { amount: 120, currency: "GBP" } },
  issues: [] as Record<string, unknown>[],
  identity: { key: "invoice:gb123:inv-1", duplicateOf: null },
};

const extraction = { grossAmount: 120, currency: "GBP" };

const knownSupplier = {
  known: { outcome: "known", message: "Known supplier." },
  duplicate: { outcome: "none", message: "" },
  bankDetails: { outcome: "consistent", message: "" },
};

const evaluate = (
  overrides: {
    policy?: Partial<DeliveryPolicy>;
    validation?: unknown;
    supplierChecks?: unknown;
    judgments?: unknown;
  } = {},
) =>
  evaluateDeliveryPolicy({
    policy: { ...DEFAULT_DELIVERY_POLICY, ...overrides.policy },
    extraction,
    validation:
      "validation" in overrides ? overrides.validation : validValidation,
    supplierChecks: overrides.supplierChecks ?? knownSupplier,
    judgments: overrides.judgments ?? [],
  });

const withIssues = (...issues: Record<string, unknown>[]) => ({
  ...validValidation,
  status: issues.some((issue) => issue.severity === "error")
    ? "invalid"
    : "needs_review",
  issues,
});

const answered = (questionId: string, answer: unknown, extra = {}) => ({
  questionId,
  label: questionId,
  status: "answered",
  answer,
  certainty: "confident",
  ...extra,
});

describe("evaluateDeliveryPolicy", () => {
  test("a valid invoice from a known supplier is delivered", () => {
    expect(evaluate()).toEqual({
      outcome: "deliver",
      reasons: [],
    });
  });

  test("missing fields and invalid totals always hold, and cannot be released", () => {
    const result = evaluate({
      validation: withIssues(
        {
          code: "missing_field",
          severity: "error",
          field: "invoiceNumber",
          message: "No invoice number was found on the document.",
        },
        {
          code: "gross",
          severity: "error",
          message: "Net plus VAT is 120.00, but the gross total is 150.00.",
        },
      ),
    });
    expect(result.outcome).toBe("hold");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "missing_required_fields",
      "invalid_financials",
    ]);
    expect(result.reasons[1]?.message).toContain("gross total is 150.00");
    expect(releasable(result.reasons)).toBe(false);
  });

  test("an unvalidated record is held", () => {
    const result = evaluate({ validation: null });
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "not_validated",
    ]);
    expect(releasable(result.reasons)).toBe(false);
  });

  test("a duplicate and a revised invoice are held with different reasons", () => {
    const duplicate = {
      ...withIssues({
        code: "duplicate",
        severity: "error",
        message: "Invoice INV-1 was already received (document a).",
      }),
      identity: { duplicateOf: "a" },
    };
    const copy = evaluate({
      validation: duplicate,
      supplierChecks: {
        ...knownSupplier,
        duplicate: { outcome: "likely_duplicate", message: "Same invoice." },
      },
    });
    expect(copy.reasons.map((reason) => reason.code)).toEqual(["duplicate"]);
    const revised = evaluate({
      validation: duplicate,
      supplierChecks: {
        ...knownSupplier,
        duplicate: {
          outcome: "revision",
          message: "Invoice INV-1 was received before with a different total.",
        },
      },
    });
    expect(revised.reasons.map((reason) => reason.code)).toEqual([
      "revised_invoice",
    ]);
    expect(revised.reasons[0]?.message).toContain("different total");
    expect(releasable(copy.reasons)).toBe(false);
    expect(releasable(revised.reasons)).toBe(false);
  });

  test("the same date and total under another number is held but may be released", () => {
    const result = evaluate({
      supplierChecks: {
        ...knownSupplier,
        duplicate: {
          outcome: "likely_duplicate",
          message: "Invoice INV-9 had the same date and total.",
        },
      },
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "possible_duplicate",
    ]);
    expect(releasable(result.reasons)).toBe(true);
    // A workspace with recurring fixed-fee invoices may deliver them.
    expect(
      evaluate({
        supplierChecks: {
          ...knownSupplier,
          duplicate: { outcome: "likely_duplicate", message: "Same." },
        },
        policy: {
          rules: {
            ...DEFAULT_DELIVERY_POLICY.rules,
            possible_duplicate: "deliver",
          },
        },
      }).outcome,
    ).toBe("deliver");
  });

  test("changed bank details are held by default and delivered when the rule allows", () => {
    const changed = {
      ...knownSupplier,
      bankDetails: {
        outcome: "changed",
        message: "The bank account ends 4321; the last invoice used 1234.",
      },
    };
    const held = evaluate({ supplierChecks: changed });
    expect(held.outcome).toBe("hold");
    expect(held.reasons[0]).toMatchObject({
      code: "bank_details_changed",
      locked: false,
    });
    expect(held.reasons[0]?.message).toContain("ends 4321");
    expect(
      evaluate({
        supplierChecks: changed,
        policy: {
          rules: {
            ...DEFAULT_DELIVERY_POLICY.rules,
            bank_details_changed: "deliver",
          },
        },
      }).outcome,
    ).toBe("deliver");
  });

  test("a low-confidence reading holds only for values a bill carries", () => {
    const lowConfidence = (field: string) =>
      withIssues({
        code: "low_confidence",
        severity: "warning",
        field,
        message: `The ${field} was selected with low confidence (41%).`,
      });
    expect(
      evaluate({ validation: lowConfidence("grossAmount") }).reasons[0]?.code,
    ).toBe("uncertain_reading");
    expect(evaluate({ validation: lowConfidence("description") }).outcome).toBe(
      "deliver",
    );
  });

  test("other warnings and new suppliers are delivered unless the policy holds them", () => {
    const warning = withIssues({
      code: "tax_not_stated",
      severity: "warning",
      message: "No VAT is shown.",
    });
    const firstInvoice = {
      ...knownSupplier,
      known: { outcome: "first_invoice", message: "First invoice from Acme." },
    };
    expect(
      evaluate({ validation: warning, supplierChecks: firstInvoice }).outcome,
    ).toBe("deliver");
    const strict = evaluate({
      validation: warning,
      supplierChecks: firstInvoice,
      policy: {
        rules: {
          ...DEFAULT_DELIVERY_POLICY.rules,
          new_supplier: "hold",
          validation_warnings: "hold",
        },
      },
    });
    expect(strict.reasons.map((reason) => reason.code)).toEqual([
      "new_supplier",
      "validation_warnings",
    ]);
  });

  test("a required question must have a confident answer", () => {
    const policy = { requiredQuestions: ["site_visit"] };
    expect(
      evaluate({ policy, judgments: [answered("site_visit", false)] }).outcome,
    ).toBe("deliver");
    const cases = [
      [],
      [{ questionId: "site_visit", status: "unknown", reason: "Not stated" }],
      [{ questionId: "site_visit", status: "failed", error: "Timeout" }],
      [{ questionId: "site_visit", status: "not_applicable", reason: "n/a" }],
      [answered("site_visit", true, { certainty: "low_confidence" })],
      [answered("site_visit", true, { certainty: "incomplete_input" })],
    ];
    for (const judgments of cases) {
      const result = evaluate({ policy, judgments });
      expect(result.reasons.map((reason) => reason.code)).toEqual([
        "required_answer_uncertain",
      ]);
      expect(releasable(result.reasons)).toBe(true);
    }
    expect(
      evaluate({ policy, judgments: cases[1] }).reasons[0]?.message,
    ).toContain("has no answer on the invoice");
  });

  test("conditions over answers hold when they match and when they cannot be checked", () => {
    const policy: Partial<DeliveryPolicy> = {
      conditions: [
        {
          kind: "answer",
          questionKey: "work_complete",
          operator: "is",
          value: false,
        },
        {
          kind: "answer",
          questionKey: "risk",
          operator: "above",
          value: 1,
        },
      ],
    };
    expect(
      evaluate({
        policy,
        judgments: [answered("work_complete", true), answered("risk", 1)],
      }).outcome,
    ).toBe("deliver");
    const matched = evaluate({
      policy,
      judgments: [answered("work_complete", false), answered("risk", 2)],
    });
    expect(matched.reasons.map((reason) => reason.code)).toEqual([
      "condition_matched",
      "condition_matched",
    ]);
    const unknown = evaluate({
      policy,
      judgments: [
        { questionId: "work_complete", status: "unknown", reason: "?" },
        answered("risk", 0),
      ],
    });
    expect(unknown.reasons.map((reason) => reason.code)).toEqual([
      "condition_unverifiable",
    ]);
  });

  test("an amount limit never converts currencies", () => {
    const policy: Partial<DeliveryPolicy> = {
      conditions: [{ kind: "gross_above", amount: 100, currency: "GBP" }],
    };
    expect(evaluate({ policy }).reasons[0]?.code).toBe("condition_matched");
    expect(
      evaluate({
        policy: {
          conditions: [{ kind: "gross_above", amount: 500, currency: "GBP" }],
        },
      }).outcome,
    ).toBe("deliver");
    const euro = evaluate({
      policy,
      validation: {
        ...validValidation,
        totals: { gross: { amount: 50, currency: "EUR" } },
      },
    });
    expect(euro.reasons[0]?.code).toBe("condition_unverifiable");
    expect(euro.reasons[0]?.message).toContain("not converted");
  });

  test("a credit note is delivered like an invoice", () => {
    const result = evaluate({
      validation: { ...validValidation, documentType: "credit_note" },
    });
    expect(result.outcome).toBe("deliver");
  });
});

describe("normalizeDeliveryPolicy", () => {
  const questions: PolicyQuestion[] = [
    { key: "work_complete", label: "Work complete", type: "boolean" },
    {
      key: "trade",
      label: "Trade",
      type: "choice",
      options: ["Plumbing", "Electrical"],
    },
    { key: "risk", label: "Risk", type: "score", options: ["Low", "High"] },
    { key: "hours", label: "Hours", type: "number" },
  ];

  test("the defaults are a valid policy", () => {
    expect(normalizeDeliveryPolicy(DEFAULT_DELIVERY_POLICY, questions)).toEqual(
      { ok: true, policy: DEFAULT_DELIVERY_POLICY },
    );
  });

  test("conditions are checked against each question's type", () => {
    const result = normalizeDeliveryPolicy(
      {
        ...DEFAULT_DELIVERY_POLICY,
        requiredQuestions: ["hours"],
        conditions: [
          {
            kind: "answer",
            questionKey: "trade",
            operator: "is",
            value: "plumbing",
          },
          { kind: "answer", questionKey: "risk", operator: "above", value: 0 },
          { kind: "gross_above", amount: 2500.5, currency: "gbp" },
        ],
      },
      questions,
    );
    expect(result).toEqual({
      ok: true,
      policy: {
        ...DEFAULT_DELIVERY_POLICY,
        requiredQuestions: ["hours"],
        conditions: [
          {
            kind: "answer",
            questionKey: "trade",
            operator: "is",
            value: "Plumbing",
          },
          { kind: "answer", questionKey: "risk", operator: "above", value: 0 },
          { kind: "gross_above", amount: 2500.5, currency: "GBP" },
        ],
      },
    });
  });

  test("locked rules, unknown questions and unbounded input are refused", () => {
    const result = normalizeDeliveryPolicy(
      {
        destinations: { accounting: "yes", webhooks: "some" },
        rules: { ...DEFAULT_DELIVERY_POLICY.rules, duplicate: "deliver" },
        requiredQuestions: ["missing", "hours", "hours"],
        conditions: [
          ...Array.from(
            { length: DELIVERY_POLICY_LIMITS.maxConditions },
            () => ({
              kind: "gross_above",
              amount: 1,
              currency: "GBP",
            }),
          ),
          {
            kind: "answer",
            questionKey: "work_complete",
            operator: "above",
            value: 3,
          },
          { kind: "script", source: "return true" },
          { kind: "gross_above", amount: 1.234, currency: "GBP" },
        ],
      },
      questions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toEqual([
      "destinations.accounting",
      "destinations.webhooks",
      "rules.duplicate",
      "requiredQuestions.0",
      "requiredQuestions.2",
      "conditions",
      "conditions.10",
      "conditions.11",
      "conditions.12",
    ]);
    expect(result.issues[2]?.message).toContain("always holds");
  });
});
