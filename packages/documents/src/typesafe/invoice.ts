import { Effect } from "effect";
import sharp from "sharp";
import { INTAKE_LIMITS } from "../intake";
import {
  type IsolatedPdfFailureCode,
  type IsolatedPdfLimits,
  extractPdfTextIsolated,
  ocrImageIsolated,
  renderPdfPageIsolated,
} from "../isolated";
import {
  type DocumentLine,
  type DocumentPageSource,
  type DocumentText,
  documentPlainText,
  linesFromPlainText,
  readableCharacters,
  readingRows,
} from "../layout";
import type { GetDocumentRequest } from "../types";
import {
  type Candidate,
  accountNameCandidates,
  accountNumberCandidates,
  addressCandidates,
  amountCandidates,
  bicCandidates,
  candidateRow,
  currencyCandidates,
  dateCandidates,
  descriptionCandidates,
  ibanCandidates,
  ibanChecksumValid,
  invoiceNumberCandidates,
  purchaseOrderCandidates,
  sortCodeCandidates,
  supplierNameCandidates,
  vatNumberCandidates,
} from "./candidates";
import {
  TypeSafe,
  type TypeSafeAnswer,
  TypeSafeError,
  type TypeSafeQuestion,
} from "./client";
import { addDays } from "./dates";
import {
  type InvoiceLineItem,
  type LineItemRow,
  lineItemRows,
} from "./line-items";

export type { InvoiceLineItem } from "./line-items";

/** How the invoice text was obtained. */
export type InvoiceTextSource = "text-layer" | "ocr" | "mixed" | "text";

export type InvoiceExtraction = {
  supplierName: string | null;
  supplierAddress: string | null;
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
  textSource: InvoiceTextSource;
  /**
   * How each page's text was read, in page order. Every page of the document
   * is listed; none is skipped. Empty when the input was already plain text.
   */
  pageSources: DocumentPageSource[];
};

export type InvoiceJudgmentQuestion =
  | {
      id: string;
      versionId?: string;
      label: string;
      type: "boolean";
      question: string;
      context?: string | null;
      criteria?: { yes?: string; no?: string };
    }
  | {
      id: string;
      versionId?: string;
      label: string;
      type: "choice";
      question: string;
      context?: string | null;
      options: readonly string[];
    }
  | {
      id: string;
      versionId?: string;
      label: string;
      type: "score";
      question: string;
      context?: string | null;
      levels: readonly string[];
    };

type InvoiceJudgmentDetails = {
  questionId: string;
  questionVersionId?: string;
  label: string;
  question: string;
  context?: string | null;
  source: "default" | "custom";
};

export type InvoiceJudgment =
  | (InvoiceJudgmentDetails & {
      status: "answered";
      type: "boolean";
      answer: boolean;
      probability: number;
    })
  | (InvoiceJudgmentDetails & {
      status: "answered";
      type: "choice";
      answer: string;
      probabilities: Record<string, number>;
      confidence: number;
    })
  | (InvoiceJudgmentDetails & {
      status: "answered";
      type: "score";
      answer: number;
      levels: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    })
  | (InvoiceJudgmentDetails & {
      /** The check has nothing to evaluate yet, e.g. no earlier invoices to compare with. */
      status: "not_applicable";
      type: InvoiceJudgmentQuestion["type"];
      reason: string;
    })
  | (InvoiceJudgmentDetails & {
      status: "failed";
      type: InvoiceJudgmentQuestion["type"];
      error: string;
    });

export type PreviousInvoice = {
  id: string;
  extraction: unknown;
};

export type ProcessedInvoice = {
  extraction: InvoiceExtraction;
  judgments: InvoiceJudgment[];
};

const ABSENT = "absent";

/**
 * Extraction bounds. A document beyond any of them fails with a clear reason
 * instead of being read in part, so an invoice whose later pages, rows or
 * line items were never seen is not saved as if it were complete.
 * `docs/document-intake.md#supported-inputs` publishes them.
 */
export const INVOICE_EXTRACTION_LIMITS = {
  /** Printed rows TypeSafe reads (roughly eight dense A4 pages). */
  maxLines: 400,
  /** Document text in `state`, well inside the model's 32k-token state budget. */
  maxStateChars: 40_000,
  /** Candidate table rows checked as line items. */
  maxLineItemRows: 120,
  /** Pages without a usable text layer that are OCR'd per document. */
  maxOcrPages: 10,
} as const;

/** Document text given to judgments alongside the complete extraction. */
const MAX_JUDGMENT_TEXT_CHARS = 16_000;

/** Bounds for the isolated PDF text extraction used by the invoice pipeline. */
const PDF_TEXT_LIMITS = {
  timeoutMs: 20_000,
  maxPages: 50,
  maxPageDimension: 10_000,
  maxTotalPixels: 100_000_000,
  maxChars: 400_000,
} as const;

/** A page with fewer letters and digits than this has no usable text layer. */
const MIN_PAGE_TEXT = 40;
/** Rendering resolution for OCR; tesseract is most accurate around 300 DPI. */
const OCR_DPI = 300;
const OCR_LIMITS: IsolatedPdfLimits = {
  timeoutMs: 60_000,
  maxPages: PDF_TEXT_LIMITS.maxPages,
  maxPageDimension: 5_000,
  maxTotalPixels: 15_000_000,
  maxChars: PDF_TEXT_LIMITS.maxChars,
  maxProcessRssBytes: 640 * 1024 * 1024,
};

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
      no: "The amounts do not reconcile.",
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
      no: "They differ from the bank details on a previous invoice from this supplier.",
    },
  },
];

// --- Reading the document ------------------------------------------------------

const readError = (reason: string, retryable: boolean) =>
  new TypeSafeError({ reason, retryable });

/** A problem with the document itself, explained to the customer as is. */
const documentError = (reason: string) =>
  new TypeSafeError({ reason, retryable: false, userMessage: reason });

const RETRYABLE_READ_FAILURES: readonly IsolatedPdfFailureCode[] = [
  "busy",
  "monitor_unavailable",
  "task_failed",
];

const OVER_READ_LIMIT =
  "The document is too large or complex to read within the processing limits. Upload the invoice pages on their own, or a smaller copy.";

const ISOLATED_FAILURE_MESSAGES: Partial<
  Record<IsolatedPdfFailureCode, string>
> = {
  malformed:
    "The document is damaged or is not a valid PDF or image. Upload a fresh copy.",
  password_protected:
    "The PDF is password protected. Upload a copy without a password.",
  limit: OVER_READ_LIMIT,
  output_limit: OVER_READ_LIMIT,
  timeout: OVER_READ_LIMIT,
  memory_limit: OVER_READ_LIMIT,
};

const isolatedError = (detail: string, code: IsolatedPdfFailureCode) =>
  new TypeSafeError({
    reason: detail,
    retryable: RETRYABLE_READ_FAILURES.includes(code),
    userMessage: ISOLATED_FAILURE_MESSAGES[code],
  });

/** How each supported input type is read; anything else is refused. */
const INPUT_KIND: Record<string, "pdf" | "image"> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
};

const fetchDocument = (documentUrl: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(documentUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Unable to fetch the document (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    catch: (error) =>
      readError(
        error instanceof Error ? error.message : "Unable to fetch the document",
        true,
      ),
  });

const ocrScale = (width: number, height: number) =>
  Math.min(
    OCR_DPI / 72,
    OCR_LIMITS.maxPageDimension / Math.max(width, height, 1),
    Math.sqrt(OCR_LIMITS.maxTotalPixels / Math.max(width * height, 1)),
  );

const ocrImage = (image: Uint8Array, page: number) =>
  Effect.promise(() => ocrImageIsolated(image, OCR_LIMITS, { page })).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.result.lines)
        : Effect.fail(
            isolatedError(
              `OCR failed (${result.code}): ${result.message}`,
              result.code,
            ),
          ),
    ),
  );

/**
 * Turns an uploaded photo upright: tesseract ignores EXIF orientation, so a
 * portrait phone photo stored sideways would otherwise be read rotated.
 */
const uprightImage = (image: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      sharp(Buffer.from(image), {
        limitInputPixels: INTAKE_LIMITS.maxImagePixels,
      })
        .rotate()
        .png()
        .toBuffer()
        .then((buffer) => new Uint8Array(buffer)),
    catch: () => documentError("The image could not be decoded for OCR"),
  });

/**
 * Reads the text of a PDF page by page: the text layer where a page has one,
 * OCR of the rendered page where it does not (a scan or an image-only export).
 */
const readPdf = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    // Text extraction runs in a killable process with explicit output
    // bounds: pdf.js cannot be interrupted on this thread in Node/Bun, and a
    // hostile PDF must not pin the extraction process.
    const extracted = yield* Effect.promise(() =>
      extractPdfTextIsolated(bytes, PDF_TEXT_LIMITS),
    );
    if (!extracted.ok) {
      return yield* Effect.fail(
        isolatedError(
          `PDF text extraction failed (${extracted.code}): ${extracted.message}`,
          extracted.code,
        ),
      );
    }
    const { pages } = extracted.result;
    const needsOcr = pages.map(
      (page) =>
        readableCharacters(documentPlainText(page.lines)) < MIN_PAGE_TEXT,
    );
    const ocrPages = needsOcr.filter(Boolean).length;
    // Decided before any OCR work: reading only some scanned pages would
    // silently drop the rest of the invoice.
    if (ocrPages > INVOICE_EXTRACTION_LIMITS.maxOcrPages) {
      return yield* Effect.fail(
        documentError(
          `This PDF has ${ocrPages} scanned pages without a text layer; at most ${INVOICE_EXTRACTION_LIMITS.maxOcrPages} scanned pages are read per invoice. Upload the invoice pages on their own, or a PDF with a text layer.`,
        ),
      );
    }
    const lines: DocumentLine[] = [];
    const pageSources: DocumentPageSource[] = [];
    for (const [index, page] of pages.entries()) {
      if (!needsOcr[index]) {
        lines.push(...page.lines);
        pageSources.push("text-layer");
        continue;
      }
      const rendered = yield* Effect.promise(() =>
        renderPdfPageIsolated(bytes, OCR_LIMITS, {
          page: index + 1,
          scale: ocrScale(page.width, page.height),
        }),
      );
      if (!rendered.ok) {
        return yield* Effect.fail(
          isolatedError(
            `Rendering page ${index + 1} for OCR failed (${rendered.code}): ${rendered.message}`,
            rendered.code,
          ),
        );
      }
      lines.push(...(yield* ocrImage(rendered.result.png, index + 1)));
      pageSources.push("ocr");
    }
    return { lines, pageSources } satisfies DocumentText;
  });

const readDocument = (request: GetDocumentRequest) =>
  Effect.gen(function* () {
    if (request.content?.trim()) {
      const document: DocumentText = {
        lines: linesFromPlainText(request.content),
        pageSources: [],
      };
      return { document, textSource: "text" as InvoiceTextSource };
    }
    if (!request.documentUrl) {
      return yield* Effect.fail(
        readError("Document URL or content is required", false),
      );
    }
    const kind = INPUT_KIND[request.mimetype.split(";")[0]!.trim()];
    if (!kind) {
      return yield* Effect.fail(
        documentError(
          `Unsupported document type ${request.mimetype}. Only PDF, JPEG and PNG invoices are processed.`,
        ),
      );
    }
    const bytes = yield* fetchDocument(request.documentUrl);
    const document: DocumentText =
      kind === "image"
        ? {
            lines: yield* ocrImage(yield* uprightImage(bytes), 1),
            pageSources: ["ocr"],
          }
        : yield* readPdf(bytes);
    const sources = new Set(document.pageSources);
    const textSource: InvoiceTextSource =
      sources.size > 1 ? "mixed" : sources.has("ocr") ? "ocr" : "text-layer";
    return { document, textSource };
  });

// --- Extraction ----------------------------------------------------------------

const lineId = (index: number) => `L${String(index).padStart(3, "0")}`;

/** The document as one tagged row per printed line; null when it does not fit. */
const taggedDocument = (lines: readonly DocumentLine[], maxChars: number) => {
  const tagged = readingRows(lines)
    .map(({ line, text }) => `${lineId(line)}| ${text}`)
    .join("\n");
  return tagged.length > maxChars ? null : tagged;
};

const tooLong = (reason: string) =>
  documentError(
    `${reason} Upload the invoice pages on their own, without appended statements or terms.`,
  );

const choiceQuestion = <T>(
  lines: readonly DocumentLine[],
  candidates: Candidate<T>[],
  instructions: unknown,
  facts: (candidate: Candidate<T>) => Record<string, unknown> = () => ({}),
): TypeSafeQuestion | undefined =>
  candidates.length === 0
    ? undefined
    : {
        type: "choice",
        instructions,
        criteria: Object.fromEntries([
          ...candidates.map((candidate) => [
            candidate.id,
            {
              value: candidate.value,
              ...facts(candidate),
              ...(candidate.label ? { label: candidate.label } : {}),
              ...(lines[candidate.line]
                ? {
                    row: `${lineId(candidate.line)}: ${candidateRow(lines, candidate).slice(0, 160)}`,
                  }
                : {}),
            },
          ]),
          [ABSENT, "None of these; the invoice does not state this value."],
        ]),
      };

const pick = <C extends { id: string }>(
  answers: Record<string, TypeSafeAnswer>,
  questionId: string,
  candidates: readonly C[],
): C | null => {
  const answer = answers[questionId];
  if (!answer || answer.type !== "choice" || answer.choice === ABSENT) {
    return null;
  }
  return candidates.find((candidate) => candidate.id === answer.choice) ?? null;
};

const SUPPLIER_RULES = [
  "The supplier is the business that issued this invoice and is owed the money.",
  "The customer being billed (`recipientCompany`, usually under 'Bill to', 'Invoice to' or 'Customer') is never the supplier.",
];

const lineItemQuestion = (row: LineItemRow): TypeSafeQuestion => ({
  type: "noul",
  instructions: {
    question:
      "Is `row` a purchased line item (a good or service being charged for), rather than a table heading, a subtotal or total, a tax summary, a discount note or payment detail?",
    tableHeader: row.header,
    row: row.source,
  },
  criteria: {
    true: "A row describing a purchased good or service with its price.",
    false: "Anything else.",
  },
});

const PAYMENT_TERMS =
  /\b(?:(?:payment\s+)?terms?|due|payable|pay(?:ment)?\s+within)\b[^\n.]{0,40}?\b(\d{1,3})\s*days?\b|\bnet\s*(\d{1,3})\s*days?\b|\bterms?\s*:?\s*net\s*(\d{1,3})(?!\d|[.,]\d)/i;

const DUE_ON_RECEIPT =
  /\b(?:due|payable)\s+(?:up)?on\s+(?:receipt|presentation)\b|\bdue\s+immediately\b/i;

const stripLeadingName = (address: string, name: string | null) => {
  if (!name) return address;
  const prefix = name.toLowerCase().replace(/\.$/, "");
  return address.toLowerCase().startsWith(prefix)
    ? address.slice(prefix.length).replace(/^[\s.,]+/, "") || address
    : address;
};

/** An extraction with none of these found says nothing about the invoice. */
const hasInvoiceContent = (extraction: InvoiceExtraction) =>
  Boolean(
    extraction.supplierName ||
      extraction.invoiceNumber ||
      extraction.invoiceDate ||
      extraction.grossAmount !== null ||
      extraction.netAmount !== null ||
      extraction.lineItems.length > 0,
  );

/**
 * Extracts an invoice from laid-out document lines. Code finds every
 * candidate value; TypeSafe reads the tagged document and selects which
 * candidate each field is (or that the invoice does not state it), and
 * confirms which table rows are purchased items; code copies the choices.
 */
export const extractInvoiceLines = (
  lines: readonly DocumentLine[],
  companyName?: string | null,
  textSource: InvoiceTextSource = "text",
  pageSources: readonly DocumentPageSource[] = [],
): Effect.Effect<InvoiceExtraction, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const typeSafe = yield* TypeSafe;
    const plain = documentPlainText(lines);
    if (readableCharacters(plain) < 20) {
      return yield* Effect.fail(
        documentError(
          "The document has no readable text, even after OCR. Upload a clearer copy.",
        ),
      );
    }
    if (lines.length > INVOICE_EXTRACTION_LIMITS.maxLines) {
      return yield* Effect.fail(
        tooLong(
          `The document has ${lines.length} printed rows; at most ${INVOICE_EXTRACTION_LIMITS.maxLines} are read per invoice.`,
        ),
      );
    }
    const invoice = taggedDocument(
      lines,
      INVOICE_EXTRACTION_LIMITS.maxStateChars,
    );
    if (invoice === null) {
      return yield* Effect.fail(
        tooLong(
          `The document has more than ${INVOICE_EXTRACTION_LIMITS.maxStateChars} characters of text, more than is read per invoice.`,
        ),
      );
    }

    const rows = lineItemRows(lines);
    if (rows.length > INVOICE_EXTRACTION_LIMITS.maxLineItemRows) {
      return yield* Effect.fail(
        tooLong(
          `The document has ${rows.length} table rows; at most ${INVOICE_EXTRACTION_LIMITS.maxLineItemRows} line items are read per invoice.`,
        ),
      );
    }
    const dates = dateCandidates(lines);
    const candidates = {
      supplier: supplierNameCandidates(lines),
      address: addressCandidates(lines),
      vatNumber: vatNumberCandidates(lines),
      invoiceNumber: invoiceNumberCandidates(lines),
      currencies: currencyCandidates(plain),
      amounts: amountCandidates(lines),
      accountName: accountNameCandidates(lines),
      accountNumber: accountNumberCandidates(lines),
      sortCode: sortCodeCandidates(lines),
      iban: ibanCandidates(lines),
      bic: bicCandidates(lines),
      description: descriptionCandidates(
        lines,
        rows.flatMap((row) =>
          row.value.description
            ? [{ value: row.value.description, line: row.line }]
            : [],
        ),
      ),
      purchaseOrder: purchaseOrderCandidates(lines),
    };

    const recipientCompany = companyName ?? null;
    const questions: Record<string, TypeSafeQuestion> = {};
    const add = (id: string, question: TypeSafeQuestion | undefined) => {
      if (question) questions[id] = question;
    };
    add(
      "supplier_name",
      choiceQuestion(lines, candidates.supplier, {
        question:
          "Which candidate is the name of the supplier that issued this invoice?",
        recipientCompany,
        rules: [
          ...SUPPLIER_RULES,
          "Prefer the business name exactly as printed, without an address or registration text.",
          "When the invoice names the issuing business in more than one way, prefer the name it gives as the registered or trading business over a bank account name.",
        ],
      }),
    );
    add(
      "supplier_address",
      choiceQuestion(lines, candidates.address, {
        question:
          "Which candidate is the postal address of the supplier that issued this invoice?",
        recipientCompany,
        rules: [
          ...SUPPLIER_RULES,
          "The address printed under 'Bill to', 'Invoice to', 'Ship to' or 'Deliver to' belongs to the customer, not the supplier.",
          "Prefer the most complete supplier address (street, town and postcode) that leaves out the business name.",
        ],
      }),
    );
    add(
      "supplier_vat_number",
      choiceQuestion(lines, candidates.vatNumber, {
        question:
          "Which candidate is the supplier's own VAT registration number?",
        recipientCompany,
        rules: ["A VAT number printed for the customer is not the supplier's."],
      }),
    );
    add(
      "invoice_number",
      choiceQuestion(
        lines,
        candidates.invoiceNumber,
        "Which candidate is this invoice's own invoice number?",
      ),
    );
    add(
      "invoice_date",
      choiceQuestion(
        lines,
        dates,
        "Which candidate is the date this invoice was issued (the invoice date or tax point)?",
      ),
    );
    add(
      "due_date",
      choiceQuestion(
        lines,
        dates,
        "Which candidate is the date by which this invoice must be paid (the due date)?",
      ),
    );
    add(
      "currency",
      choiceQuestion(
        lines,
        candidates.currencies,
        "Which ISO 4217 currency are this invoice's amounts in?",
      ),
    );
    add(
      "net_amount",
      choiceQuestion(
        lines,
        candidates.amounts,
        "Which candidate is the invoice's net total (the subtotal before VAT or tax)?",
      ),
    );
    add(
      "vat_amount",
      choiceQuestion(
        lines,
        candidates.amounts,
        "Which candidate is the invoice's total VAT or tax amount (a money amount, not a percentage rate)?",
      ),
    );
    add(
      "gross_amount",
      choiceQuestion(
        lines,
        candidates.amounts,
        "Which candidate is the invoice's final total including VAT (the total or amount due)?",
      ),
    );
    add(
      "bank_account_name",
      choiceQuestion(
        lines,
        candidates.accountName,
        "Which candidate is the name on the bank account this invoice should be paid into?",
      ),
    );
    add(
      "bank_account_number",
      choiceQuestion(
        lines,
        candidates.accountNumber,
        "Which candidate is the bank account number this invoice should be paid into (not a company registration number or phone number)?",
      ),
    );
    add(
      "bank_sort_code",
      choiceQuestion(
        lines,
        candidates.sortCode,
        "Which candidate is the UK bank sort code this invoice should be paid to?",
      ),
    );
    add(
      "bank_iban",
      choiceQuestion(
        lines,
        candidates.iban,
        "Which candidate is the IBAN this invoice should be paid to?",
        (candidate) => ({
          checksumValid: ibanChecksumValid(candidate.value),
        }),
      ),
    );
    add(
      "bank_bic",
      choiceQuestion(
        lines,
        candidates.bic,
        "Which candidate is the BIC or SWIFT code of the bank this invoice should be paid to?",
      ),
    );
    add(
      "description",
      choiceQuestion(
        lines,
        candidates.description,
        "Which candidate best summarises the goods or services this invoice charges for?",
      ),
    );
    add(
      "purchase_order_reference",
      choiceQuestion(
        lines,
        candidates.purchaseOrder,
        "Which candidate is the customer's purchase-order number or order reference?",
      ),
    );
    const itemQuestions = Object.fromEntries(
      rows.map((row) => [row.id, lineItemQuestion(row)]),
    );

    const state = { invoice, recipientCompany };
    const evaluate = (batch: Record<string, TypeSafeQuestion>) =>
      Object.keys(batch).length === 0
        ? Effect.succeed({} as Record<string, TypeSafeAnswer>)
        : typeSafe.evaluate({ state, questions: batch }).pipe(
            Effect.flatMap(({ answers }) =>
              Object.keys(batch).some((id) => answers[id] === undefined)
                ? Effect.fail(
                    new TypeSafeError({
                      reason: "TypeSafe omitted an invoice extraction answer",
                      retryable: false,
                    }),
                  )
                : Effect.succeed(answers),
            ),
          );
    // Field choices and row checks are independent; asking them in two
    // parallel requests keeps each inside the model's context budget.
    const [fieldAnswers, itemAnswers] = yield* Effect.all(
      [evaluate(questions), evaluate(itemQuestions)],
      { concurrency: 2 },
    );

    const supplierName =
      pick(fieldAnswers, "supplier_name", candidates.supplier)?.value ?? null;
    const address = pick(
      fieldAnswers,
      "supplier_address",
      candidates.address,
    )?.value;
    const invoiceDate = pick(fieldAnswers, "invoice_date", dates)?.iso ?? null;
    let dueDate = pick(fieldAnswers, "due_date", dates)?.iso ?? null;
    if (!dueDate && invoiceDate && DUE_ON_RECEIPT.test(plain)) {
      dueDate = invoiceDate;
    }
    if (!dueDate && invoiceDate) {
      const terms = PAYMENT_TERMS.exec(plain);
      const days = Number(terms?.[1] ?? terms?.[2] ?? terms?.[3]);
      if (Number.isInteger(days) && days > 0) {
        dueDate = addDays(invoiceDate, days);
      }
    }

    const extraction: InvoiceExtraction = {
      supplierName: supplierName?.replace(/\.$/, "") ?? null,
      supplierAddress: address ? stripLeadingName(address, supplierName) : null,
      supplierVatNumber:
        pick(fieldAnswers, "supplier_vat_number", candidates.vatNumber)
          ?.value ?? null,
      invoiceNumber:
        pick(fieldAnswers, "invoice_number", candidates.invoiceNumber)?.value ??
        null,
      invoiceDate,
      dueDate,
      currency:
        pick(fieldAnswers, "currency", candidates.currencies)?.value ?? null,
      netAmount:
        pick(fieldAnswers, "net_amount", candidates.amounts)?.value ?? null,
      vatAmount:
        pick(fieldAnswers, "vat_amount", candidates.amounts)?.value ?? null,
      grossAmount:
        pick(fieldAnswers, "gross_amount", candidates.amounts)?.value ?? null,
      lineItems: rows
        .filter((row) => {
          const answer = itemAnswers[row.id];
          return answer?.type === "noul" && answer.noul >= 0.5;
        })
        .map((row) => row.value),
      bankDetails: {
        accountName:
          pick(fieldAnswers, "bank_account_name", candidates.accountName)
            ?.value ?? null,
        accountNumber:
          pick(fieldAnswers, "bank_account_number", candidates.accountNumber)
            ?.value ?? null,
        sortCode:
          pick(fieldAnswers, "bank_sort_code", candidates.sortCode)?.value ??
          null,
        iban: pick(fieldAnswers, "bank_iban", candidates.iban)?.value ?? null,
        bic: pick(fieldAnswers, "bank_bic", candidates.bic)?.value ?? null,
      },
      description:
        pick(fieldAnswers, "description", candidates.description)?.value ??
        null,
      purchaseOrderReference:
        pick(fieldAnswers, "purchase_order_reference", candidates.purchaseOrder)
          ?.value ?? null,
      textSource,
      pageSources: [...pageSources],
    };

    if (!hasInvoiceContent(extraction)) {
      return yield* Effect.fail(
        documentError(
          "No invoice details could be read from this document. Check that it is an invoice and upload a clearer copy.",
        ),
      );
    }
    return extraction;
  });

/** Extracts an invoice from text that is already laid out one row per line. */
export const extractInvoiceText = (
  text: string,
  companyName?: string | null,
): Effect.Effect<InvoiceExtraction, TypeSafeError, TypeSafe> =>
  extractInvoiceLines(linesFromPlainText(text), companyName, "text");

// --- Judgments -------------------------------------------------------------------

const toTypeSafeQuestion = (
  question: InvoiceJudgmentQuestion,
): TypeSafeQuestion => {
  const instructions = question.context
    ? { question: question.question, context: question.context }
    : question.question;
  if (question.type === "boolean") {
    const criteria = {
      true: question.criteria?.yes,
      false: question.criteria?.no,
    };
    return question.criteria
      ? {
          type: "noul",
          instructions,
          criteria,
        }
      : {
          type: "noul",
          instructions,
        };
  }
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions,
      criteria: Object.fromEntries(
        question.options.map((option, index) => [`option_${index}`, option]),
      ),
    };
  }
  return {
    type: "score",
    instructions,
    criteria: question.levels,
  };
};

const judgmentDetails = (
  question: InvoiceJudgmentQuestion,
  source: "default" | "custom",
): InvoiceJudgmentDetails => ({
  questionId: question.id,
  questionVersionId: question.versionId,
  label: question.label,
  question: question.question,
  context: question.context,
  source,
});

const toJudgment = (
  question: InvoiceJudgmentQuestion,
  answer: TypeSafeAnswer,
  source: "default" | "custom",
): InvoiceJudgment | null => {
  if (question.type === "boolean" && answer.type === "noul") {
    return {
      ...judgmentDetails(question, source),
      status: "answered",
      type: "boolean",
      answer: answer.noul >= 0.5,
      probability: answer.noul,
    };
  }
  if (question.type === "choice" && answer.type === "choice") {
    const optionIndex = Number.parseInt(answer.choice.replace("option_", ""));
    const selected = question.options[optionIndex];
    if (selected === undefined) return null;
    return {
      ...judgmentDetails(question, source),
      status: "answered",
      type: "choice",
      answer: selected,
      probabilities: Object.fromEntries(
        Object.entries(answer.probabilities).map(([key, probability]) => {
          const index = Number.parseInt(key.replace("option_", ""));
          return [question.options[index] ?? key, probability];
        }),
      ),
      confidence: answer.confidence,
    };
  }
  if (question.type === "score" && answer.type === "score") {
    return {
      ...judgmentDetails(question, source),
      status: "answered",
      type: "score",
      answer: answer.score,
      levels: answer.legend,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  return null;
};

const failedJudgment = (
  question: InvoiceJudgmentQuestion,
  source: "default" | "custom",
  error: string,
): InvoiceJudgment => ({
  ...judgmentDetails(question, source),
  status: "failed",
  type: question.type,
  error,
});

const notApplicable = (
  question: InvoiceJudgmentQuestion,
  source: "default" | "custom",
  reason: string,
): InvoiceJudgment => ({
  ...judgmentDetails(question, source),
  status: "not_applicable",
  type: question.type,
  reason,
});

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const hasBankDetails = (extraction: unknown) =>
  Object.values(asRecord(asRecord(extraction).bankDetails)).some(
    (value) => typeof value === "string" && value.trim() !== "",
  );

const supplierKey = (name: unknown) =>
  typeof name === "string"
    ? name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\b(?:ltd|limited|plc|llp|inc|llc|co|company|the|uk)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

/** A previous invoice plausibly from the same supplier: same name or VAT number. */
const fromSameSupplier = (
  extraction: InvoiceExtraction,
  previous: PreviousInvoice,
) => {
  const other = asRecord(previous.extraction);
  const name = supplierKey(extraction.supplierName);
  const vat = extraction.supplierVatNumber;
  return (
    (name !== "" && supplierKey(other.supplierName) === name) ||
    (vat !== null && other.supplierVatNumber === vat)
  );
};

const NO_HISTORY =
  "There are no earlier invoices in this workspace to compare with yet.";

/**
 * Default checks whose premise does not hold for this invoice. They compare
 * against history or need specific extracted values; without those there is
 * nothing to judge, and the honest answer is "not applicable", not "no".
 * Custom questions are always asked.
 */
const inapplicableReason = (
  question: InvoiceJudgmentQuestion,
  extraction: InvoiceExtraction,
  previousInvoices: readonly PreviousInvoice[],
): string | null => {
  switch (question.id) {
    case "likely_duplicate":
    case "known_supplier":
      return previousInvoices.length === 0 ? NO_HISTORY : null;
    case "bank_details_consistent":
      if (!hasBankDetails(extraction)) {
        return "No bank details were found on this invoice to compare.";
      }
      if (previousInvoices.length === 0) return NO_HISTORY;
      return previousInvoices.some(
        (invoice) =>
          hasBankDetails(invoice.extraction) &&
          (!extraction.supplierName || fromSameSupplier(extraction, invoice)),
      )
        ? null
        : "No earlier invoice from this supplier has bank details to compare with.";
    case "vat_calculation_correct":
      return extraction.netAmount === null ||
        extraction.vatAmount === null ||
        extraction.grossAmount === null
        ? "The net, VAT and gross amounts were not all found on this invoice."
        : null;
    default:
      return null;
  }
};

export const judgeInvoice = (
  extraction: InvoiceExtraction,
  previousInvoices: readonly PreviousInvoice[],
  customQuestions: readonly InvoiceJudgmentQuestion[] = [],
  defaultQuestions: readonly InvoiceJudgmentQuestion[] = DEFAULT_INVOICE_JUDGMENTS,
  invoiceText?: string | null,
): Effect.Effect<InvoiceJudgment[], TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const typeSafe = yield* TypeSafe;
    const configured = [
      ...defaultQuestions.map((question) => ({
        question,
        source: "default" as const,
        skip: inapplicableReason(question, extraction, previousInvoices),
      })),
      ...customQuestions.map((question) => ({
        question,
        source: "custom" as const,
        skip: null,
      })),
    ];
    const wireId = (index: number) => `judgment_${index}`;
    const asked = configured.flatMap((entry, index) =>
      entry.skip ? [] : [[wireId(index), toTypeSafeQuestion(entry.question)]],
    );
    const answers: Record<string, TypeSafeAnswer> =
      asked.length === 0
        ? {}
        : (yield* typeSafe.evaluate({
            state: {
              currentInvoice: extraction,
              // The document itself, so a question can be answered from what
              // the invoice says even where no field captured it.
              invoiceText: invoiceText
                ? invoiceText.slice(0, MAX_JUDGMENT_TEXT_CHARS)
                : null,
              previousInvoices,
            },
            questions: Object.fromEntries(asked),
          })).answers;
    return configured.map(({ question, source, skip }, index) => {
      if (skip) return notApplicable(question, source, skip);
      const answer = answers[wireId(index)];
      if (!answer) {
        return failedJudgment(
          question,
          source,
          "TypeSafe omitted this invoice judgment answer",
        );
      }
      const judgment = toJudgment(question, answer, source);
      return (
        judgment ??
        failedJudgment(
          question,
          source,
          "TypeSafe returned the wrong answer type for this question",
        )
      );
    });
  });

export const processInvoice = (
  request: GetDocumentRequest,
): Effect.Effect<ProcessedInvoice, TypeSafeError, TypeSafe> =>
  Effect.gen(function* () {
    const { document, textSource } = yield* readDocument(request);
    const extraction = yield* extractInvoiceLines(
      document.lines,
      request.companyName,
      textSource,
      document.pageSources,
    );
    const defaultQuestions =
      request.defaultJudgmentQuestions ?? DEFAULT_INVOICE_JUDGMENTS;
    const configuredQuestions = [
      ...defaultQuestions,
      ...(request.judgmentQuestions ?? []),
    ];
    const judgments = yield* judgeInvoice(
      extraction,
      request.previousInvoices ?? [],
      request.judgmentQuestions ?? [],
      defaultQuestions,
      documentPlainText(document.lines),
    ).pipe(
      Effect.catchAll((error) =>
        Effect.succeed(
          configuredQuestions.map((question) =>
            failedJudgment(
              question,
              defaultQuestions.includes(question) ? "default" : "custom",
              error.reason,
            ),
          ),
        ),
      ),
    );
    return { extraction, judgments };
  });
