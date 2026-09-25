/**
 * Delivery rules: which processed invoices are sent to the workspace's
 * destinations automatically, and why any other is held.
 *
 * A workspace policy is a small, fixed vocabulary, not a rules engine: a few
 * built-in checks over the validation, the supplier-history checks and the
 * question answers already stored with every invoice, a list of questions
 * that must be answered with confidence, and at most
 * `DELIVERY_POLICY_LIMITS.maxConditions` conditions of two shapes. The same
 * inputs always give the same decision.
 *
 * Plain code, no model, and no Node-only imports, so the dashboard shows the
 * rules from the same definitions the worker applies.
 * `docs/delivery.md#delivery-rules` publishes them.
 */

/** Bumped whenever an evaluation rule changes; stored on every decision. */
export const DELIVERY_RULES_VERSION = 1;

export const DELIVERY_POLICY_LIMITS = {
  maxConditions: 10,
  maxRequiredQuestions: 20,
  /** Largest amount a condition may name, in major units. */
  maxAmount: 1_000_000_000,
  maxResolutionReasonLength: 500,
} as const;

/** Built-in checks a workspace may switch between holding and delivering. */
export const CONFIGURABLE_DELIVERY_RULES = [
  "possible_duplicate",
  "bank_details_changed",
  "uncertain_reading",
  "new_supplier",
  "validation_warnings",
] as const;

export type ConfigurableDeliveryRule =
  (typeof CONFIGURABLE_DELIVERY_RULES)[number];

export type DeliveryRuleAction = "hold" | "deliver";

export type DeliveryCondition =
  | {
      kind: "answer";
      questionKey: string;
      /** `is`/`is_not` for yes/no and choice questions. */
      operator: "is" | "is_not";
      value: boolean | string;
    }
  | {
      kind: "answer";
      questionKey: string;
      /** `above`/`below` for number questions and score positions. */
      operator: "above" | "below";
      value: number;
    }
  | {
      kind: "gross_above";
      /** Major units of `currency`; amounts in another currency are not converted. */
      amount: number;
      currency: string;
    };

export type DeliveryPolicy = {
  destinations: {
    /** Post eligible invoices to the connected accounting software. */
    accounting: boolean;
    /**
     * `eligible`: webhook events are sent only for eligible (or released)
     * invoices. `all`: every processed invoice is sent, carrying its decision.
     */
    webhooks: "eligible" | "all";
  };
  rules: Record<ConfigurableDeliveryRule, DeliveryRuleAction>;
  /** Questions whose answer must be a confident answer before delivery. */
  requiredQuestions: string[];
  conditions: DeliveryCondition[];
};

/**
 * What a workspace gets before anyone changes its rules. Everything a draft
 * bill cannot safely represent is always held (see `LOCKED_DELIVERY_RULES`);
 * a changed bank account and a value read with low confidence are held too.
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  destinations: { accounting: true, webhooks: "eligible" },
  rules: {
    possible_duplicate: "hold",
    bank_details_changed: "hold",
    uncertain_reading: "hold",
    new_supplier: "deliver",
    validation_warnings: "deliver",
  },
  requiredQuestions: [],
  conditions: [],
};

/** Checks that always hold an invoice; only a corrected or re-read invoice clears them. */
export const LOCKED_DELIVERY_RULES = [
  "missing_required_fields",
  "invalid_financials",
  "duplicate",
] as const;

export type LockedDeliveryRule = (typeof LOCKED_DELIVERY_RULES)[number];

export type DeliveryRuleId =
  | LockedDeliveryRule
  | ConfigurableDeliveryRule
  | "required_questions"
  | "conditions"
  | "approval";

/** The rules in words, in the order the dashboard and docs list them. */
export const DELIVERY_RULE_DESCRIPTIONS: Record<
  DeliveryRuleId,
  { label: string; description: string }
> = {
  missing_required_fields: {
    label: "Missing required fields",
    description:
      "The supplier, invoice number, invoice date, currency or gross total was not found on the document.",
  },
  invalid_financials: {
    label: "Invalid financial data",
    description:
      "The totals, VAT or line items do not add up, amounts are in different currencies, the total is negative or the due date is before the invoice date.",
  },
  duplicate: {
    label: "Duplicate or revised invoice",
    description:
      "An earlier document from the same supplier has the same invoice number: a copy, or a revised invoice with a different date or total.",
  },
  possible_duplicate: {
    label: "Possible duplicate",
    description:
      "An earlier invoice from the same supplier has the same date and total under another number.",
  },
  bank_details_changed: {
    label: "Changed bank details",
    description:
      "The bank account differs from the supplier's most recent invoice with bank details.",
  },
  uncertain_reading: {
    label: "Uncertain reading",
    description:
      "The supplier, invoice number, dates, currency or an amount was read with low confidence.",
  },
  new_supplier: {
    label: "New or unidentified supplier",
    description:
      "This is the supplier's first invoice, or the supplier could not be identified.",
  },
  validation_warnings: {
    label: "Other validation warnings",
    description:
      "Warnings such as no VAT shown, VAT without a VAT number, or VAT number and IBAN check digits that fail.",
  },
  required_questions: {
    label: "Required questions",
    description:
      "Each required question must have a confident answer. An unknown, uncertain, failed or missing answer holds the invoice.",
  },
  conditions: {
    label: "Conditions",
    description:
      "Hold when a question's answer matches, or when the gross total is above a limit.",
  },
  approval: {
    label: "Approval after a correction",
    description:
      "A member corrected an invoice while it was held; an owner or admin releases it.",
  },
};

export type DeliveryReasonCode =
  | "not_validated"
  | "missing_required_fields"
  | "invalid_financials"
  | "duplicate"
  | "revised_invoice"
  | "possible_duplicate"
  | "bank_details_changed"
  | "uncertain_reading"
  | "new_supplier"
  | "validation_warnings"
  | "required_answer_uncertain"
  | "condition_matched"
  | "condition_unverifiable"
  | "awaiting_approval";

export type DeliveryReason = {
  code: DeliveryReasonCode;
  rule: DeliveryRuleId;
  message: string;
  /**
   * Release cannot clear it: the invoice must be corrected or read again
   * (or dismissed), because a bill could not safely carry it.
   */
  locked: boolean;
};

export type DeliveryEvaluation = {
  outcome: "deliver" | "hold";
  reasons: DeliveryReason[];
};

// --- Normalisation -------------------------------------------------------------

/** A workspace question as a condition can refer to it. */
export type PolicyQuestion = {
  key: string;
  label: string;
  type: "boolean" | "choice" | "score" | "number";
  /** Choice options or score levels. */
  options?: readonly string[] | null;
};

export type DeliveryPolicyIssue = { path: string; message: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Checks a submitted policy against the vocabulary and the workspace's
 * questions. Every problem is reported, with the path it is at; nothing is
 * guessed or dropped.
 */
export function normalizeDeliveryPolicy(
  input: unknown,
  questions: readonly PolicyQuestion[],
):
  | { ok: true; policy: DeliveryPolicy }
  | { ok: false; issues: DeliveryPolicyIssue[] } {
  const issues: DeliveryPolicyIssue[] = [];
  const record = asRecord(input);
  const byKey = new Map(questions.map((question) => [question.key, question]));

  const destinations = asRecord(record.destinations);
  if (typeof destinations.accounting !== "boolean") {
    issues.push({
      path: "destinations.accounting",
      message: "Choose whether eligible invoices are posted to accounting.",
    });
  }
  if (destinations.webhooks !== "eligible" && destinations.webhooks !== "all") {
    issues.push({
      path: "destinations.webhooks",
      message: 'Webhooks receive either "eligible" or "all" invoices.',
    });
  }

  const rules = asRecord(record.rules);
  for (const key of Object.keys(rules)) {
    if (!(CONFIGURABLE_DELIVERY_RULES as readonly string[]).includes(key)) {
      issues.push({
        path: `rules.${key}`,
        message: (LOCKED_DELIVERY_RULES as readonly string[]).includes(key)
          ? `${DELIVERY_RULE_DESCRIPTIONS[key as LockedDeliveryRule].label} always holds an invoice and cannot be changed.`
          : "Unknown rule.",
      });
    }
  }
  for (const key of CONFIGURABLE_DELIVERY_RULES) {
    if (rules[key] !== "hold" && rules[key] !== "deliver") {
      issues.push({
        path: `rules.${key}`,
        message: `${DELIVERY_RULE_DESCRIPTIONS[key].label}: choose "hold" or "deliver".`,
      });
    }
  }

  const required = Array.isArray(record.requiredQuestions)
    ? record.requiredQuestions
    : null;
  if (!required) {
    issues.push({
      path: "requiredQuestions",
      message: "Required questions must be a list of question keys.",
    });
  } else {
    if (required.length > DELIVERY_POLICY_LIMITS.maxRequiredQuestions) {
      issues.push({
        path: "requiredQuestions",
        message: `At most ${DELIVERY_POLICY_LIMITS.maxRequiredQuestions} questions can be required.`,
      });
    }
    const seen = new Set<string>();
    required.forEach((key, index) => {
      if (typeof key !== "string" || !byKey.has(key)) {
        issues.push({
          path: `requiredQuestions.${index}`,
          message: "Unknown question.",
        });
      } else if (seen.has(key)) {
        issues.push({
          path: `requiredQuestions.${index}`,
          message: `${byKey.get(key)!.label} is listed twice.`,
        });
      }
      if (typeof key === "string") seen.add(key);
    });
  }

  const conditions = Array.isArray(record.conditions)
    ? record.conditions
    : null;
  const normalized: DeliveryCondition[] = [];
  if (!conditions) {
    issues.push({
      path: "conditions",
      message: "Conditions must be a list.",
    });
  } else {
    if (conditions.length > DELIVERY_POLICY_LIMITS.maxConditions) {
      issues.push({
        path: "conditions",
        message: `At most ${DELIVERY_POLICY_LIMITS.maxConditions} conditions are allowed.`,
      });
    }
    conditions.forEach((raw, index) => {
      const result = normalizeCondition(raw, byKey);
      if (typeof result === "string") {
        issues.push({ path: `conditions.${index}`, message: result });
      } else {
        normalized.push(result);
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    policy: {
      destinations: {
        accounting: destinations.accounting as boolean,
        webhooks: destinations.webhooks as "eligible" | "all",
      },
      rules: Object.fromEntries(
        CONFIGURABLE_DELIVERY_RULES.map((key) => [key, rules[key]]),
      ) as DeliveryPolicy["rules"],
      requiredQuestions: [...new Set(required as string[])],
      conditions: normalized,
    },
  };
}

function normalizeCondition(
  raw: unknown,
  questions: ReadonlyMap<string, PolicyQuestion>,
): DeliveryCondition | string {
  const condition = asRecord(raw);
  if (condition.kind === "gross_above") {
    const amount = condition.amount;
    const currency =
      typeof condition.currency === "string"
        ? condition.currency.trim().toUpperCase()
        : "";
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      amount > DELIVERY_POLICY_LIMITS.maxAmount ||
      Math.round(amount * 100) !== amount * 100
    ) {
      return `The limit must be an amount from 0 to ${DELIVERY_POLICY_LIMITS.maxAmount}, with at most two decimals.`;
    }
    if (!CURRENCY.test(currency)) {
      return "The limit needs a three-letter currency code.";
    }
    return { kind: "gross_above", amount, currency };
  }
  if (condition.kind !== "answer") return "Unknown condition.";
  const key = condition.questionKey;
  const question = typeof key === "string" ? questions.get(key) : undefined;
  if (!question) return "Unknown question.";
  const { operator, value } = condition;
  switch (question.type) {
    case "boolean":
      if (
        (operator !== "is" && operator !== "is_not") ||
        typeof value !== "boolean"
      ) {
        return `${question.label} is a yes/no question: hold when it is (or is not) yes or no.`;
      }
      return { kind: "answer", questionKey: question.key, operator, value };
    case "choice": {
      const option = (question.options ?? []).find(
        (candidate) =>
          typeof value === "string" &&
          candidate.toLowerCase() === value.trim().toLowerCase(),
      );
      if ((operator !== "is" && operator !== "is_not") || !option) {
        return `${question.label} is a choice question: hold when it is (or is not) one of its options.`;
      }
      return {
        kind: "answer",
        questionKey: question.key,
        operator,
        value: option,
      };
    }
    case "score": {
      const levels = question.options?.length ?? 0;
      if (
        (operator !== "above" && operator !== "below") ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= levels
      ) {
        return `${question.label} is a score: hold when it is above or below one of its ${levels} levels.`;
      }
      return { kind: "answer", questionKey: question.key, operator, value };
    }
    case "number":
      if (
        (operator !== "above" && operator !== "below") ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        Math.abs(value) > DELIVERY_POLICY_LIMITS.maxAmount
      ) {
        return `${question.label} is a number question: hold when it is above or below a number.`;
      }
      return { kind: "answer", questionKey: question.key, operator, value };
  }
}

// --- Evaluation -------------------------------------------------------------------

/** Fields a bill carries: a low-confidence reading of any of them is uncertain. */
const POSTED_FIELDS = new Set([
  "documentType",
  "supplierName",
  "supplierVatNumber",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "currency",
  "netAmount",
  "vatAmount",
  "grossAmount",
]);

type Issue = {
  code?: unknown;
  severity?: unknown;
  field?: unknown;
  message?: unknown;
};

type Judgment = {
  questionId?: unknown;
  label?: unknown;
  status?: unknown;
  type?: unknown;
  answer?: unknown;
  certainty?: unknown;
  reason?: unknown;
  error?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

const joinMessages = (issues: readonly Issue[]) =>
  issues
    .map((issue) => text(issue.message))
    .filter(Boolean)
    .join(" ");

const confident = (judgment: Judgment | undefined) =>
  judgment?.status === "answered" &&
  (judgment.certainty === undefined || judgment.certainty === "confident");

const describeUncertain = (judgment: Judgment | undefined) => {
  if (!judgment) return "was not answered";
  switch (judgment.status) {
    case "unknown":
      return "has no answer on the invoice";
    case "not_applicable":
      return "does not apply to this invoice";
    case "failed":
      return "could not be evaluated";
    default:
      return judgment.certainty === "incomplete_input"
        ? "was answered from incomplete evidence"
        : "was answered with low confidence";
  }
};

const formatAnswer = (judgment: Judgment) =>
  typeof judgment.answer === "boolean"
    ? judgment.answer
      ? "yes"
      : "no"
    : String(judgment.answer);

const conditionText = (condition: DeliveryCondition, label: string) => {
  if (condition.kind === "gross_above") {
    return `the gross total is above ${condition.currency} ${condition.amount.toFixed(2)}`;
  }
  const value =
    typeof condition.value === "boolean"
      ? condition.value
        ? "yes"
        : "no"
      : String(condition.value);
  const operator = {
    is: "is",
    is_not: "is not",
    above: "is above",
    below: "is below",
  }[condition.operator];
  return `${label} ${operator} ${value}`;
};

/**
 * Applies a policy to one invoice revision. Holds are reported with the rule
 * that produced them and whether a release may clear them; an answer that is
 * unknown or uncertain is never read as no or zero.
 */
export function evaluateDeliveryPolicy(input: {
  policy: DeliveryPolicy;
  extraction: unknown;
  validation: unknown;
  supplierChecks: unknown;
  judgments: unknown;
}): DeliveryEvaluation {
  const { policy } = input;
  const reasons: DeliveryReason[] = [];
  const hold = (reason: DeliveryReason) => reasons.push(reason);
  const validation = asRecord(input.validation);

  if (!input.validation || !Array.isArray(validation.issues)) {
    hold({
      code: "not_validated",
      rule: "invalid_financials",
      message:
        "This invoice has not been validated. Re-extract or correct it so its values are checked.",
      locked: true,
    });
    return { outcome: "hold", reasons };
  }

  const issues = (validation.issues as unknown[]).map(
    (issue) => asRecord(issue) as Issue,
  );
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  const missing = errors.filter((issue) => issue.code === "missing_field");
  if (missing.length > 0) {
    hold({
      code: "missing_required_fields",
      rule: "missing_required_fields",
      message: joinMessages(missing),
      locked: true,
    });
  }

  const checks = asRecord(input.supplierChecks);
  const duplicateCheck = asRecord(checks.duplicate);
  const duplicateIssue = errors.find((issue) => issue.code === "duplicate");
  if (duplicateIssue || asRecord(validation.identity).duplicateOf) {
    const revised = duplicateCheck.outcome === "revision";
    hold({
      code: revised ? "revised_invoice" : "duplicate",
      rule: "duplicate",
      message: revised
        ? `${text(duplicateCheck.message) || text(duplicateIssue?.message)} A revised invoice is not posted as a second bill: correct the original invoice, or dismiss this copy.`
        : `${text(duplicateIssue?.message) || "An earlier document has the same invoice number."} It is not delivered again.`,
      locked: true,
    });
  } else if (
    policy.rules.possible_duplicate === "hold" &&
    duplicateCheck.outcome === "likely_duplicate"
  ) {
    hold({
      code: "possible_duplicate",
      rule: "possible_duplicate",
      message: `${text(duplicateCheck.message)} Release it if it is a separate invoice, or dismiss it.`,
      locked: false,
    });
  }

  const invalid = errors.filter(
    (issue) => issue.code !== "missing_field" && issue.code !== "duplicate",
  );
  if (invalid.length > 0) {
    hold({
      code: "invalid_financials",
      rule: "invalid_financials",
      message: joinMessages(invalid),
      locked: true,
    });
  }

  const bank = asRecord(checks.bankDetails);
  if (
    policy.rules.bank_details_changed === "hold" &&
    bank.outcome === "changed"
  ) {
    hold({
      code: "bank_details_changed",
      rule: "bank_details_changed",
      message: `${text(bank.message) || "The bank details differ from the supplier's earlier invoices; confirm the change with the supplier through a contact you already hold."} Release it once the new account is confirmed.`,
      locked: false,
    });
  }

  const uncertain = warnings.filter(
    (issue) =>
      issue.code === "low_confidence" && POSTED_FIELDS.has(text(issue.field)),
  );
  if (policy.rules.uncertain_reading === "hold" && uncertain.length > 0) {
    hold({
      code: "uncertain_reading",
      rule: "uncertain_reading",
      message: `${joinMessages(uncertain)} Correct the value, or release it if it is right.`,
      locked: false,
    });
  }

  const known = asRecord(checks.known);
  if (
    policy.rules.new_supplier === "hold" &&
    (known.outcome === "first_invoice" ||
      known.outcome === "insufficient_evidence")
  ) {
    hold({
      code: "new_supplier",
      rule: "new_supplier",
      message:
        text(known.message) ||
        "This supplier has not sent an invoice before, or could not be identified.",
      locked: false,
    });
  }

  const otherWarnings = warnings.filter(
    (issue) => issue.code !== "low_confidence",
  );
  if (policy.rules.validation_warnings === "hold" && otherWarnings.length > 0) {
    hold({
      code: "validation_warnings",
      rule: "validation_warnings",
      message: joinMessages(otherWarnings),
      locked: false,
    });
  }

  const judgments = (Array.isArray(input.judgments) ? input.judgments : []).map(
    (judgment) => asRecord(judgment) as Judgment,
  );
  const answerTo = (key: string) =>
    judgments.find((judgment) => judgment.questionId === key);
  const labelOf = (key: string, judgment?: Judgment) =>
    text(judgment?.label) || key;

  for (const key of policy.requiredQuestions) {
    const judgment = answerTo(key);
    if (confident(judgment)) continue;
    hold({
      code: "required_answer_uncertain",
      rule: "required_questions",
      message: `The required question "${labelOf(key, judgment)}" ${describeUncertain(judgment)}. Rerun the questions, or release it after checking the invoice yourself.`,
      locked: false,
    });
  }

  const extraction = asRecord(input.extraction);
  for (const condition of policy.conditions) {
    if (condition.kind === "gross_above") {
      const gross = asRecord(asRecord(validation.totals).gross);
      const amount =
        typeof gross.amount === "number"
          ? gross.amount
          : typeof extraction.grossAmount === "number"
            ? extraction.grossAmount
            : null;
      const currency = text(gross.currency) || text(extraction.currency);
      if (amount === null || currency !== condition.currency) {
        hold({
          code: "condition_unverifiable",
          rule: "conditions",
          message: `The condition "${conditionText(condition, "")}" could not be checked: ${
            amount === null
              ? "the invoice has no gross total"
              : `the invoice is in ${currency || "an unknown currency"}, and amounts are not converted`
          }.`,
          locked: false,
        });
      } else if (Math.abs(amount) > condition.amount) {
        hold({
          code: "condition_matched",
          rule: "conditions",
          message: `The gross total ${currency} ${Math.abs(amount).toFixed(2)} is above the ${condition.currency} ${condition.amount.toFixed(2)} limit.`,
          locked: false,
        });
      }
      continue;
    }
    const judgment = answerTo(condition.questionKey);
    if (!confident(judgment) || judgment === undefined) {
      hold({
        code: "condition_unverifiable",
        rule: "conditions",
        message: `The condition "${conditionText(condition, labelOf(condition.questionKey, judgment))}" could not be checked: the question ${describeUncertain(judgment)}.`,
        locked: false,
      });
      continue;
    }
    const answer = judgment.answer;
    const matched =
      condition.operator === "is"
        ? typeof answer === "string" && typeof condition.value === "string"
          ? answer.toLowerCase() === condition.value.toLowerCase()
          : answer === condition.value
        : condition.operator === "is_not"
          ? typeof answer === "string" && typeof condition.value === "string"
            ? answer.toLowerCase() !== condition.value.toLowerCase()
            : answer !== condition.value
          : typeof answer === "number" &&
            typeof condition.value === "number" &&
            (condition.operator === "above"
              ? answer > condition.value
              : answer < condition.value);
    if (matched) {
      hold({
        code: "condition_matched",
        rule: "conditions",
        message: `The condition "${conditionText(condition, labelOf(condition.questionKey, judgment))}" matched: the answer was ${formatAnswer(judgment)}.`,
        locked: false,
      });
    }
  }

  return {
    outcome: reasons.length > 0 ? "hold" : "deliver",
    reasons,
  };
}

/** Whether a release may clear every reason an invoice is held for. */
export const releasable = (reasons: readonly { locked?: unknown }[]) =>
  reasons.every((reason) => reason.locked !== true);
