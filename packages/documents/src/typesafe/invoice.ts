import { Effect } from "effect";
import { extractText, getDocumentProxy } from "unpdf";
import type { GetDocumentRequest } from "../types";
import {
  TypeSafe,
  type TypeSafeAnswer,
  TypeSafeError,
  type TypeSafeQuestion,
} from "./client";

export type InvoiceLineItem = {
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
};

export type InvoiceExtraction = {
  supplierName: string | null;
  supplierVatNumber: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  netAmount: number | null;
  vatAmount: number | null;
  grossAmount: number | null;
  lineItems: InvoiceLineItem[];
  bankDetails: {
    accountName: string | null;
    accountNumber: string | null;
    sortCode: string | null;
    iban: string | null;
    bic: string | null;
  };
  description: string | null;
  purchaseOrderReference: string | null;
};

export type InvoiceJudgmentQuestion =
  | {
      id: string;
      label: string;
      type: "boolean";
      question: string;
      criteria?: { yes?: string; no?: string };
    }
  | {
      id: string;
      label: string;
      type: "enum";
      question: string;
      options: Record<string, string | null>;
    }
  | {
      id: string;
      label: string;
      type: "number";
      question: string;
      levels: readonly string[];
    };

export type InvoiceJudgment =
  | {
      questionId: string;
      label: string;
      source: "default" | "custom";
      type: "boolean";
      answer: boolean;
      probability: number;
    }
  | {
      questionId: string;
      label: string;
      source: "default" | "custom";
      type: "enum";
      answer: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      questionId: string;
      label: string;
      source: "default" | "custom";
      type: "number";
      answer: number;
      levels: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type PreviousInvoice = {
  id: string;
  extraction: unknown;
};

export type ProcessedInvoice = {
  extraction: InvoiceExtraction;
  judgments: InvoiceJudgment[];
};

type Candidate<T> = {
  id: string;
  value: T;
  source: string;
};

const ABSENT = "absent";
const MAX_TEXT_LENGTH = 60_000;

export const DEFAULT_INVOICE_JUDGMENTS: readonly InvoiceJudgmentQuestion[] = [
  {
    id: "likely_duplicate",
    label: "Likely duplicate",
    type: "boolean",
    question:
      "Is `currentInvoice` likely a duplicate of any entry in `previousInvoices`?",
    criteria: {
      yes: "The supplier and invoice number match, or the supplier, date and gross amount strongly indicate the same invoice.",
      no: "No previous invoice describes the same bill.",
    },
  },
  {
    id: "vat_calculation_correct",
    label: "VAT calculation correct",
    type: "boolean",
    question:
      "Is the VAT calculation on `currentInvoice` arithmetically correct, so net amount plus VAT amount equals gross amount?",
    criteria: {
      yes: "The stated amounts reconcile, allowing normal currency rounding.",
      no: "The amounts are missing or do not reconcile.",
    },
  },
  {
    id: "known_supplier",
    label: "Known supplier",
    type: "boolean",
    question:
      "Does `currentInvoice.supplierName` identify a supplier present in `previousInvoices`?",
    criteria: {
      yes: "A previous invoice is from the same supplier, allowing ordinary legal-name variations.",
      no: "There is no previous invoice from this supplier.",
    },
  },
  {
    id: "bank_details_consistent",
    label: "Bank details consistent",
    type: "boolean",
    question:
      "Are `currentInvoice.bankDetails` consistent with bank details on previous invoices from the same supplier?",
    criteria: {
      yes: "The material bank identifiers match a previous invoice from this supplier.",
      no: "They differ, are absent, or there is no prior bank detail for this supplier to compare.",
    },
  },
];

const cleanLines = (text: string) =>
  text
    .replaceAll("\u0000", "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 250);

const unique = <T>(candidates: Candidate<T>[]) => {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const fromLabels = (
  lines: string[],
  patterns: readonly RegExp[],
  prefix: string,
): Candidate<string>[] => {
  const found: Candidate<string>[] = [];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      const value = match?.[1]?.trim();
      if (value) {
        found.push({ id: `${prefix}_${found.length}`, value, source: line });
        break;
      }
    }
  }
  return unique(found);
};

const DATE_PATTERN =
  /\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi;

const dateCandidates = (lines: string[]): Candidate<string>[] => {
  const found: Candidate<string>[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(DATE_PATTERN)) {
      found.push({
        id: `date_${found.length}`,
        value: match[0],
        source: line,
      });
    }
  }
  return unique(found);
};

const MONEY_PATTERN =
  /(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF|£|€|\$)\s*-?\d[\d.,]*|\b-?\d[\d.,]*\s*(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\b/gi;

const parseMoney = (raw: string): number | null => {
  const cleaned = raw.replace(/[^\d,.-]/g, "");
  if (!cleaned) return null;
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    normalized = cleaned
      .replace(decimal === "," ? /\./g : /,/g, "")
      .replace(decimal, ".");
  } else if (comma >= 0) {
    normalized = /,\d{2}$/.test(cleaned)
      ? cleaned.replace(",", ".")
      : cleaned.replace(/,/g, "");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const amountCandidates = (lines: string[]): Candidate<number>[] => {
  const found: Candidate<number>[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(MONEY_PATTERN)) {
      const value = parseMoney(match[0]);
      if (value !== null) {
        found.push({
          id: `amount_${found.length}`,
          value,
          source: line,
        });
      }
    }
  }
  return unique(found);
};

const currencyCandidates = (text: string): Candidate<string>[] => {
  const currencies = new Set<string>();
  for (const match of text.matchAll(
    /\b(?:GBP|USD|EUR|CAD|AUD|NZD|SEK|NOK|DKK|CHF)\b/g,
  )) {
    currencies.add(match[0]);
  }
  if (text.includes("£")) currencies.add("GBP");
  if (text.includes("€")) currencies.add("EUR");
  if (text.includes("$") && currencies.size === 0) currencies.add("USD");
  return [...currencies].map((value, index) => ({
    id: `currency_${index}`,
    value,
    source: `Currency marker in the invoice resolves to ${value}`,
  }));
};

const supplierCandidates = (lines: string[]): Candidate<string>[] =>
  lines
    .slice(0, 40)
    .filter(
      (line) =>
        /[A-Za-z]{2}/.test(line) &&
        line.length <= 100 &&
        !/^(invoice|bill to|ship to|date|due|vat|tax|subtotal|total|description|quantity|qty|unit|price|purchase order|po\b)/i.test(
          line,
        ),
    )
    .map((value, index) => ({
      id: `supplier_${index}`,
      value,
      source: value,
    }));

const normalizeDate = (raw: string | null): string | null => {
  if (!raw) return null;
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  if (iso) {
    return `${iso[1]}-${iso[2]!.padStart(2, "0")}-${iso[3]!.padStart(2, "0")}`;
  }
  const local = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(raw);
  if (local) {
    const year = local[3]!.length === 2 ? `20${local[3]}` : local[3]!;
    return `${year}-${local[2]!.padStart(2, "0")}-${local[1]!.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10);
};

const lineItemCandidates = (lines: string[]): Candidate<InvoiceLineItem>[] => {
  const items: Candidate<InvoiceLineItem>[] = [];
  for (const line of lines) {
    if (
      /\b(subtotal|net total|vat|tax|gross|amount due|total due|total)\b/i.test(
        line,
      )
    ) {
      continue;
    }
    const piped =
      /^(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*((?:[A-Z]{3}|[£€$])?\s*\d[\d.,]*)\s*\|\s*((?:[A-Z]{3}|[£€$])?\s*\d[\d.,]*)$/i.exec(
        line,
      );
    if (!piped) continue;
    const unitPrice = parseMoney(piped[3]!);
    const total = parseMoney(piped[4]!);
    if (unitPrice === null || total === null) continue;
    items.push({
      id: `line_item_${items.length}`,
      value: {
        description: piped[1]!.trim() || null,
        quantity: Number(piped[2]),
        unitPrice,
        total,
      },
      source: line,
    });
  }
  return items;
};

const choiceQuestion = <T>(
  candidates: Candidate<T>[],
  instructions: unknown,
): TypeSafeQuestion | undefined =>
  candidates.length === 0
    ? undefined
    : {
        type: "choice",
        instructions,
        criteria: Object.fromEntries([
          ...candidates.map((candidate) => [
            candidate.id,
            { value: candidate.value, source: candidate.source },
          ]),
          [ABSENT, "The invoice does not state this value."],
        ]),
      };

const pick = <T>(
  answers: Record<string, TypeSafeAnswer>,
  questionId: string,
  candidates: Candidate<T>[],
): T | null => {
  const answer = answers[questionId];
  if (!answer || answer.type !== "choice" || answer.choice === ABSENT) {
    return null;
  }
  return (
    candidates.find((candidate) => candidate.id === answer.choice)?.value ??
    null
  );
};

const questionsFor = (input: {
  supplier: Candidate<string>[];
  vatNumber: Candidate<string>[];
  invoiceNumber: Candidate<string>[];
  dates: Candidate<string>[];
  currencies: Candidate<string>[];
  amounts: Candidate<number>[];
  accountName: Candidate<string>[];
  accountNumber: Candidate<string>[];
  sortCode: Candidate<string>[];
  iban: Candidate<string>[];
  bic: Candidate<string>[];
  description: Candidate<string>[];
  purchaseOrder: Candidate<string>[];
  lineItems: Candidate<InvoiceLineItem>[];
  companyName?: string | null;
}) => {
  const questions: Record<string, TypeSafeQuestion> = {};
  const add = (id: string, question: TypeSafeQuestion | undefined) => {
    if (question) questions[id] = question;
  };
  add(
    "supplier_name",
    choiceQuestion(input.supplier, {
      question:
        "Which candidate is the legal supplier issuing this invoice? Pick absent when none is a supplier name.",
      recipientCompany: input.companyName ?? null,
      warning:
        "The recipient/customer is not the supplier, even when its name appears prominently.",
    }),
  );
  add(
    "supplier_vat_number",
    choiceQuestion(
      input.vatNumber,
      "Which candidate is the supplier's VAT registration number?",
    ),
  );
  add(
    "invoice_number",
    choiceQuestion(
      input.invoiceNumber,
      "Which candidate is the invoice number?",
    ),
  );
  add(
    "invoice_date",
    choiceQuestion(input.dates, "Which candidate is the invoice issue date?"),
  );
  add(
    "due_date",
    choiceQuestion(input.dates, "Which candidate is the payment due date?"),
  );
  add(
    "currency",
    choiceQuestion(
      input.currencies,
      "Which ISO 4217 currency applies to the invoice amounts?",
    ),
  );
  add(
    "net_amount",
    choiceQuestion(
      input.amounts,
      "Which candidate is the net or subtotal amount before VAT/tax?",
    ),
  );
  add(
    "vat_amount",
    choiceQuestion(input.amounts, "Which candidate is the VAT or tax amount?"),
  );
  add(
    "gross_amount",
    choiceQuestion(
      input.amounts,
      "Which candidate is the final gross total or amount due?",
    ),
  );
  add(
    "bank_account_name",
    choiceQuestion(
      input.accountName,
      "Which candidate is the bank account holder name for payment?",
    ),
  );
  add(
    "bank_account_number",
    choiceQuestion(
      input.accountNumber,
      "Which candidate is the bank account number for payment?",
    ),
  );
  add(
    "bank_sort_code",
    choiceQuestion(
      input.sortCode,
      "Which candidate is the bank sort code for payment?",
    ),
  );
  add(
    "bank_iban",
    choiceQuestion(input.iban, "Which candidate is the payment IBAN?"),
  );
  add(
    "bank_bic",
    choiceQuestion(
      input.bic,
      "Which candidate is the payment BIC or SWIFT code?",
    ),
  );
  add(
    "description",
    choiceQuestion(
      input.description,
      "Which candidate best describes the goods or services invoiced?",
    ),
  );
  add(
    "purchase_order_reference",
    choiceQuestion(
      input.purchaseOrder,
      "Which candidate is the customer's purchase-order reference?",
    ),
  );
  for (const candidate of input.lineItems) {
    questions[candidate.id] = {
      type: "noul",
      instructions: {
        question:
          "Is `candidate` a purchased line item, rather than a heading, invoice total, tax summary or payment detail?",
        candidate: candidate.source,
      },
      criteria: {
        true: "A row describing a purchased good or service with its quantity and price.",
        false: "Anything else.",
      },
    };
  }
  return questions;
};

export const extractInvoiceText = (
  text: string,
  companyName?: string | null,
): Effect.Effect<InvoiceExtraction, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const typeSafe = yield* TypeSafe;
    const documentText = text.slice(0, MAX_TEXT_LENGTH);
    const lines = cleanLines(documentText);
    const candidates = {
      supplier: supplierCandidates(lines),
      vatNumber: fromLabels(
        lines,
        [
          /\b(?:supplier\s+)?vat\s*(?:number|no\.?|registration)?\s*[:#]?\s*([A-Z]{0,2}[A-Z0-9][A-Z0-9 .-]{5,18})\s*$/i,
        ],
        "vat",
      ),
      invoiceNumber: fromLabels(
        lines,
        [/\binvoice\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9./_-]*)/i],
        "invoice_number",
      ),
      dates: dateCandidates(lines),
      currencies: currencyCandidates(documentText),
      amounts: amountCandidates(lines),
      accountName: fromLabels(
        lines,
        [/\baccount\s*(?:name|holder)\s*[:#]?\s*(.+)$/i],
        "account_name",
      ),
      accountNumber: fromLabels(
        lines,
        [/\baccount\s*(?:number|no\.?)\s*[:#]?\s*([A-Z0-9 -]+)$/i],
        "account_number",
      ),
      sortCode: fromLabels(
        lines,
        [/\bsort\s*code\s*[:#]?\s*([0-9 -]+)$/i],
        "sort_code",
      ),
      iban: fromLabels(
        lines,
        [/\biban\s*[:#]?\s*([A-Z]{2}[0-9A-Z ]{12,32})$/i],
        "iban",
      ),
      bic: fromLabels(
        lines,
        [/\b(?:bic|swift)\s*[:#]?\s*([A-Z0-9]{8,11})$/i],
        "bic",
      ),
      description: fromLabels(
        lines,
        [/^(?:description|services?|work)\s*[:#]?\s*(.+)$/i],
        "description",
      ),
      purchaseOrder: fromLabels(
        lines,
        [
          /\b(?:purchase\s+order|p\.?o\.?)\s*(?:number|no\.?|reference|ref\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9./_-]*)/i,
        ],
        "purchase_order",
      ),
      lineItems: lineItemCandidates(lines),
      companyName,
    };
    const questions = questionsFor(candidates);
    const answers =
      Object.keys(questions).length === 0
        ? {}
        : (yield* typeSafe.evaluate({
            state: { documentText, recipientCompany: companyName ?? null },
            questions,
          })).answers;
    if (Object.keys(questions).some((id) => answers[id] === undefined)) {
      return yield* Effect.fail(
        new TypeSafeError({
          reason: "TypeSafe omitted an invoice extraction answer",
          retryable: false,
        }),
      );
    }

    return {
      supplierName: pick(answers, "supplier_name", candidates.supplier),
      supplierVatNumber: pick(
        answers,
        "supplier_vat_number",
        candidates.vatNumber,
      ),
      invoiceNumber: pick(answers, "invoice_number", candidates.invoiceNumber),
      invoiceDate: normalizeDate(
        pick(answers, "invoice_date", candidates.dates),
      ),
      dueDate: normalizeDate(pick(answers, "due_date", candidates.dates)),
      currency: pick(answers, "currency", candidates.currencies),
      netAmount: pick(answers, "net_amount", candidates.amounts),
      vatAmount: pick(answers, "vat_amount", candidates.amounts),
      grossAmount: pick(answers, "gross_amount", candidates.amounts),
      lineItems: candidates.lineItems
        .filter((candidate) => {
          const answer = answers[candidate.id];
          return answer?.type === "noul" && answer.noul >= 0.5;
        })
        .map((candidate) => candidate.value),
      bankDetails: {
        accountName: pick(answers, "bank_account_name", candidates.accountName),
        accountNumber: pick(
          answers,
          "bank_account_number",
          candidates.accountNumber,
        ),
        sortCode: pick(answers, "bank_sort_code", candidates.sortCode),
        iban: pick(answers, "bank_iban", candidates.iban),
        bic: pick(answers, "bank_bic", candidates.bic),
      },
      description: pick(answers, "description", candidates.description),
      purchaseOrderReference: pick(
        answers,
        "purchase_order_reference",
        candidates.purchaseOrder,
      ),
    };
  });

const toTypeSafeQuestion = (
  question: InvoiceJudgmentQuestion,
): TypeSafeQuestion => {
  if (question.type === "boolean") {
    const criteria = {
      true: question.criteria?.yes,
      false: question.criteria?.no,
    };
    return question.criteria
      ? {
          type: "noul",
          instructions: question.question,
          criteria,
        }
      : {
          type: "noul",
          instructions: question.question,
        };
  }
  if (question.type === "enum") {
    return {
      type: "choice",
      instructions: question.question,
      criteria: question.options,
    };
  }
  return {
    type: "score",
    instructions: question.question,
    criteria: question.levels,
  };
};

const toJudgment = (
  question: InvoiceJudgmentQuestion,
  answer: TypeSafeAnswer,
  source: "default" | "custom",
): InvoiceJudgment | null => {
  if (question.type === "boolean" && answer.type === "noul") {
    return {
      questionId: question.id,
      label: question.label,
      source,
      type: "boolean",
      answer: answer.noul >= 0.5,
      probability: answer.noul,
    };
  }
  if (question.type === "enum" && answer.type === "choice") {
    return {
      questionId: question.id,
      label: question.label,
      source,
      type: "enum",
      answer: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  if (question.type === "number" && answer.type === "score") {
    return {
      questionId: question.id,
      label: question.label,
      source,
      type: "number",
      answer: answer.score,
      levels: answer.legend,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  return null;
};

export const judgeInvoice = (
  extraction: InvoiceExtraction,
  previousInvoices: readonly PreviousInvoice[],
  customQuestions: readonly InvoiceJudgmentQuestion[] = [],
): Effect.Effect<InvoiceJudgment[], TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const typeSafe = yield* TypeSafe;
    const configured = [
      ...DEFAULT_INVOICE_JUDGMENTS.map((question) => ({
        question,
        source: "default" as const,
      })),
      ...customQuestions.map((question) => ({
        question,
        source: "custom" as const,
      })),
    ];
    const wireIds = configured.map((_, index) => `judgment_${index}`);
    const response = yield* typeSafe.evaluate({
      state: {
        currentInvoice: extraction,
        previousInvoices,
      },
      questions: Object.fromEntries(
        configured.map(({ question }, index) => [
          wireIds[index]!,
          toTypeSafeQuestion(question),
        ]),
      ),
    });
    if (wireIds.some((id) => response.answers[id] === undefined)) {
      return yield* Effect.fail(
        new TypeSafeError({
          reason: "TypeSafe omitted an invoice judgment answer",
          retryable: false,
        }),
      );
    }
    const judgments = configured.flatMap(({ question, source }, index) => {
      const answer = response.answers[wireIds[index]!];
      if (!answer) return [];
      const judgment = toJudgment(question, answer, source);
      return judgment ? [judgment] : [];
    });
    if (judgments.length !== configured.length) {
      return yield* Effect.fail(
        new TypeSafeError({
          reason: "TypeSafe returned the wrong invoice judgment type",
          retryable: false,
        }),
      );
    }
    return judgments;
  });

const loadPdfText = (documentUrl: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(documentUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`Unable to fetch PDF (${response.status})`);
      const pdf = await getDocumentProxy(await response.arrayBuffer());
      const { text } = await extractText(pdf);
      const value = (Array.isArray(text) ? text.join("\n") : text)
        .replaceAll("\u0000", "")
        .trim();
      if (!value) throw new Error("PDF contains no extractable text");
      return value;
    },
    catch: (error) =>
      new TypeSafeError({
        reason:
          error instanceof Error ? error.message : "Unable to read invoice PDF",
        retryable: false,
      }),
  });

export const processInvoice = (
  request: GetDocumentRequest,
): Effect.Effect<ProcessedInvoice, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const text = request.content?.trim()
      ? request.content
      : request.documentUrl
        ? yield* loadPdfText(request.documentUrl)
        : yield* Effect.fail(
            new TypeSafeError({
              reason: "Document URL or content is required",
              retryable: false,
            }),
          );
    const extraction = yield* extractInvoiceText(text, request.companyName);
    const judgments = yield* judgeInvoice(
      extraction,
      request.previousInvoices ?? [],
      request.judgmentQuestions ?? [],
    );
    return { extraction, judgments };
  });
