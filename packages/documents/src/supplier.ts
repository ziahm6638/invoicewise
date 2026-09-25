/**
 * Workspace supplier identity and the checks that compare an invoice with its
 * supplier's history.
 *
 * Plain code, no model: the same records always resolve and compare the same
 * way. A supplier is resolved from explicit identifiers first (VAT number,
 * company number); a name alone only resolves when exactly one workspace
 * supplier carries it, so two businesses that share a name are never merged
 * by guesswork. Bank details are what the history checks watch for changes,
 * so they never decide identity.
 *
 * `docs/document-intake.md#supplier-identity-and-history` publishes these rules.
 */
import type { PreviousInvoice } from "./typesafe/invoice";
import type { InvoiceValidation } from "./validation";
import { documentNumberKey, supplierKey, toMinor, vatKey } from "./validation";

/** Bumped whenever a rule below changes, so stored results can be told apart. */
export const SUPPLIER_CHECKS_VERSION = 1;

/**
 * Retrieval bounds for one invoice's supplier history. Each is a separate
 * indexed query over the supplier's whole retained history, so an old
 * duplicate or an old set of bank details is still found.
 */
export const SUPPLIER_HISTORY_LIMITS = {
  /** The supplier's most recent invoices. */
  recent: 20,
  /** Earlier documents from the supplier with the same (or credited) number. */
  sameNumber: 10,
  /** Earlier documents from the supplier with the same date and total. */
  sameDateAndTotal: 10,
  /** The supplier's most recent invoices that print bank details. */
  withBankDetails: 5,
  /** The supplier's earliest invoices that print these exact bank details. */
  sameBankDetails: 3,
} as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

// --- Identifiers ---------------------------------------------------------------

/** A company registration number without spacing, punctuation or case; UK numbers padded to 8 digits. */
export const companyNumberKey = (value: unknown) => {
  if (typeof value !== "string") return "";
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^\d{1,8}$/.test(compact) ? compact.padStart(8, "0") : compact;
};

export type SupplierIdentifiers = {
  /** The name as printed, for display. */
  name: string | null;
  nameKey: string;
  vatKey: string;
  companyKey: string;
};

export const supplierIdentifiersOf = (
  extraction: unknown,
): SupplierIdentifiers => {
  const record = asRecord(extraction);
  return {
    name: text(record.supplierName),
    nameKey: supplierKey(record.supplierName),
    vatKey: vatKey(record.supplierVatNumber),
    companyKey: companyNumberKey(record.supplierCompanyNumber),
  };
};

// --- Resolution ------------------------------------------------------------------

/** A workspace supplier record; `canonicalId` is the supplier it was merged into, or its own id. */
export type SupplierRecord = {
  id: string;
  canonicalId: string;
  nameKey: string;
  vatKey: string | null;
  companyKey: string | null;
};

export type SupplierMatchMethod = "vat_number" | "company_number" | "name";

export type SupplierResolution =
  | {
      status: "matched";
      /** The canonical supplier. */
      supplierId: string;
      method: SupplierMatchMethod;
      /** Identifiers printed on this invoice that the supplier did not have yet. */
      learn: { vatKey?: string; companyKey?: string };
      message: string;
    }
  | {
      status: "new";
      method: SupplierMatchMethod;
      message: string;
    }
  | {
      status: "unresolved";
      reason:
        | "ambiguous_name"
        | "conflicting_identifiers"
        | "no_supplier_identity";
      /** The canonical suppliers it could have been. */
      candidateIds: string[];
      message: string;
    };

const unique = (values: string[]) => [...new Set(values)];

/**
 * Decides which workspace supplier issued an invoice.
 *
 * 1. A VAT or company number held by a supplier resolves to it, unless the
 *    invoice's identifiers point at different suppliers, or the supplier
 *    holds a different number of the same kind (conflicting identifiers).
 * 2. With a VAT or company number no supplier holds, the invoice resolves to
 *    the one supplier with its name only when that supplier has no
 *    identifiers yet; otherwise it is a new supplier, because a different
 *    registration number is a different business.
 * 3. With a name only, it resolves when exactly one supplier carries the
 *    name, is a new supplier when none does, and stays unresolved when more
 *    than one does (ambiguous name).
 */
export function resolveSupplier(
  identifiers: SupplierIdentifiers,
  suppliers: readonly SupplierRecord[],
): SupplierResolution {
  const { nameKey, vatKey: vat, companyKey: company } = identifiers;
  if (!nameKey && !vat && !company) {
    return {
      status: "unresolved",
      reason: "no_supplier_identity",
      candidateIds: [],
      message:
        "No supplier name, VAT number or company number was read from the invoice.",
    };
  }

  const group = (canonicalId: string) =>
    suppliers.filter((supplier) => supplier.canonicalId === canonicalId);
  const keysOf = (canonicalId: string, key: "vatKey" | "companyKey") =>
    new Set(
      group(canonicalId)
        .map((supplier) => supplier[key])
        .filter((value): value is string => Boolean(value)),
    );

  const byVat = vat ? suppliers.filter((s) => s.vatKey === vat) : [];
  const byCompany = company
    ? suppliers.filter((s) => s.companyKey === company)
    : [];
  const matched = unique(
    [...byVat, ...byCompany].map((supplier) => supplier.canonicalId),
  );

  if (matched.length > 1) {
    return {
      status: "unresolved",
      reason: "conflicting_identifiers",
      candidateIds: matched,
      message:
        "The invoice's VAT number and company number belong to different suppliers in this workspace.",
    };
  }

  if (matched.length === 1) {
    const supplierId = matched[0]!;
    const vats = keysOf(supplierId, "vatKey");
    const companies = keysOf(supplierId, "companyKey");
    if (
      (vat && vats.size > 0 && !vats.has(vat)) ||
      (company && companies.size > 0 && !companies.has(company))
    ) {
      return {
        status: "unresolved",
        reason: "conflicting_identifiers",
        candidateIds: matched,
        message:
          "The invoice matches a supplier by one registration number but prints a different number of another kind than that supplier's.",
      };
    }
    const method = byVat.length > 0 ? "vat_number" : "company_number";
    return {
      status: "matched",
      supplierId,
      method,
      learn: {
        ...(vat && vats.size === 0 ? { vatKey: vat } : {}),
        ...(company && companies.size === 0 ? { companyKey: company } : {}),
      },
      message:
        method === "vat_number"
          ? "Matched by VAT number."
          : "Matched by company number.",
    };
  }

  const named = nameKey
    ? unique(
        suppliers
          .filter((supplier) => supplier.nameKey === nameKey)
          .map((supplier) => supplier.canonicalId),
      )
    : [];

  if (vat || company) {
    const onlyByName =
      named.length === 1 &&
      keysOf(named[0]!, "vatKey").size === 0 &&
      keysOf(named[0]!, "companyKey").size === 0;
    if (onlyByName) {
      return {
        status: "matched",
        supplierId: named[0]!,
        method: "name",
        learn: {
          ...(vat ? { vatKey: vat } : {}),
          ...(company ? { companyKey: company } : {}),
        },
        message:
          "Matched by name to the one supplier with this name, which had no registration number yet.",
      };
    }
    return {
      status: "new",
      method: vat ? "vat_number" : "company_number",
      message:
        named.length > 0
          ? "A new supplier: another supplier has this name but a different (or no confirmed) registration number."
          : "A new supplier, identified by its registration number.",
    };
  }

  if (named.length === 1) {
    return {
      status: "matched",
      supplierId: named[0]!,
      method: "name",
      learn: {},
      message:
        "Matched by name; exactly one supplier in this workspace has this name.",
    };
  }
  if (named.length > 1) {
    return {
      status: "unresolved",
      reason: "ambiguous_name",
      candidateIds: named,
      message: `${named.length} suppliers in this workspace share this name and the invoice prints no VAT or company number to tell them apart.`,
    };
  }
  return {
    status: "new",
    method: "name",
    message: "A new supplier, identified by name only.",
  };
}

// --- Bank details ----------------------------------------------------------------

/** Comparable forms of an invoice's bank details; a GB IBAN also yields its sort code and account. */
export type BankAccountKeys = {
  iban: string | null;
  /** `sortcode:account`, digits only. */
  ukAccount: string | null;
};

const digits = (value: unknown) =>
  typeof value === "string" ? value.replace(/\D/g, "") : "";

export const bankAccountKeysOf = (extraction: unknown): BankAccountKeys => {
  const bank = asRecord(asRecord(extraction).bankDetails);
  const iban =
    typeof bank.iban === "string"
      ? bank.iban.toUpperCase().replace(/[^A-Z0-9]/g, "")
      : "";
  const sort = digits(bank.sortCode);
  const account = digits(bank.accountNumber);
  let ukAccount = sort.length === 6 && account ? `${sort}:${account}` : null;
  const gb = /^GB\d{2}[A-Z]{4}(\d{6})(\d{8})$/.exec(iban);
  if (!ukAccount && gb) ukAccount = `${gb[1]}:${gb[2]}`;
  return { iban: iban || null, ukAccount };
};

export const hasBankAccount = (keys: BankAccountKeys) =>
  keys.iban !== null || keys.ukAccount !== null;

type BankComparison = "same" | "different" | "incomparable";

const compareBank = (
  a: BankAccountKeys,
  b: BankAccountKeys,
): BankComparison => {
  if (a.iban && b.iban) return a.iban === b.iban ? "same" : "different";
  if (a.ukAccount && b.ukAccount) {
    return a.ukAccount === b.ukAccount ? "same" : "different";
  }
  return "incomparable";
};

/** What may be shown or logged about bank details: the kind and last four characters, never the account. */
export type MaskedBankAccount = {
  kind: "iban" | "uk_account";
  ending: string;
};

export const maskBankAccount = (
  keys: BankAccountKeys,
): MaskedBankAccount | null =>
  keys.iban
    ? { kind: "iban", ending: keys.iban.slice(-4) }
    : keys.ukAccount
      ? { kind: "uk_account", ending: keys.ukAccount.slice(-4) }
      : null;

export const describeBankAccount = (masked: MaskedBankAccount) =>
  `${masked.kind === "iban" ? "IBAN" : "account"} ending ${masked.ending}`;

// --- History checks --------------------------------------------------------------

/** An earlier document from the supplier, oldest or newest; `receivedAt` orders them. */
export type SupplierHistoryRecord = PreviousInvoice & { receivedAt: string };

export type SupplierCheckSupplier = {
  status: "matched" | "new" | "unresolved" | "manual";
  /** The canonical supplier; null when unresolved. */
  supplierId: string | null;
  name: string | null;
  method: SupplierMatchMethod | "manual" | null;
  message: string;
  candidateIds?: string[];
};

export type SupplierEvidence = {
  invoiceId: string;
  reason:
    | "same_number"
    | "same_number_changed"
    | "same_date_and_total"
    | "credited_invoice"
    | "first_invoice"
    | "latest_bank_details"
    | "same_bank_details";
  bankAccount?: MaskedBankAccount | null;
};

export type SupplierChecks = {
  version: typeof SUPPLIER_CHECKS_VERSION;
  checkedAt: string;
  supplier: SupplierCheckSupplier;
  known: {
    outcome: "known" | "first_invoice" | "insufficient_evidence";
    message: string;
    earlierInvoices: number;
    evidence: SupplierEvidence[];
  };
  duplicate: {
    outcome:
      | "none"
      | "likely_duplicate"
      | "revision"
      | "credit_note"
      | "insufficient_evidence";
    message: string;
    evidence: SupplierEvidence[];
  };
  bankDetails: {
    outcome: "consistent" | "changed" | "not_present" | "insufficient_evidence";
    message: string;
    current: MaskedBankAccount | null;
    evidence: SupplierEvidence[];
  };
  /** Every earlier record these results were computed from. */
  historyIds: string[];
};

const docType = (extraction: unknown) =>
  asRecord(extraction).documentType === "credit_note"
    ? "credit_note"
    : "invoice";

const grossMinor = (extraction: unknown) => {
  const value = asRecord(extraction).grossAmount;
  return typeof value === "number" && Number.isFinite(value)
    ? toMinor(Math.abs(value))
    : null;
};

const dateOf = (extraction: unknown) => text(asRecord(extraction).invoiceDate);

const label = (extraction: unknown) => {
  const record = asRecord(extraction);
  const number = text(record.invoiceNumber);
  const kind =
    docType(extraction) === "credit_note" ? "credit note" : "invoice";
  return number ? `${kind} ${number}` : `an earlier ${kind}`;
};

const UNRESOLVED_HISTORY =
  "The supplier could not be identified with confidence, so there is no supplier history to compare with.";

/**
 * Compares an invoice with its supplier's earlier documents.
 *
 * `history` holds the retrieved earlier documents from the same (canonical)
 * supplier, newest first; `earlierInvoices` counts all of them, however far
 * back; `firstInvoice` is the oldest.
 */
export function checkSupplierHistory(input: {
  extraction: unknown;
  validation?: Pick<InvoiceValidation, "identity"> | null;
  supplier: SupplierCheckSupplier;
  history: readonly SupplierHistoryRecord[];
  earlierInvoices: number;
  firstInvoice?: SupplierHistoryRecord | null;
  now?: Date;
}): SupplierChecks {
  const { extraction, supplier, history } = input;
  const resolved = supplier.supplierId !== null;
  const name = supplier.name ?? "this supplier";

  // --- Known supplier.
  const known: SupplierChecks["known"] = !resolved
    ? {
        outcome: "insufficient_evidence",
        message: `${supplier.message} ${UNRESOLVED_HISTORY}`,
        earlierInvoices: 0,
        evidence: [],
      }
    : input.earlierInvoices > 0
      ? {
          outcome: "known",
          message: `${input.earlierInvoices} earlier ${input.earlierInvoices === 1 ? "document" : "documents"} from ${name} in this workspace${input.firstInvoice ? `, the first received ${input.firstInvoice.receivedAt.slice(0, 10)}` : ""}.`,
          earlierInvoices: input.earlierInvoices,
          evidence: input.firstInvoice
            ? [{ invoiceId: input.firstInvoice.id, reason: "first_invoice" }]
            : [],
        }
      : {
          outcome: "first_invoice",
          message: `This is the first document from ${name} in this workspace.`,
          earlierInvoices: 0,
          evidence: [],
        };

  // --- Duplicate, revision or credit note.
  const type = docType(extraction);
  const number = documentNumberKey(asRecord(extraction).invoiceNumber);
  const gross = grossMinor(extraction);
  const date = dateOf(extraction);
  let duplicate: SupplierChecks["duplicate"];
  const sameNumber = number
    ? history.filter(
        (record) =>
          docType(record.extraction) === type &&
          documentNumberKey(asRecord(record.extraction).invoiceNumber) ===
            number,
      )
    : [];
  const changed = (record: SupplierHistoryRecord) => {
    const otherGross = grossMinor(record.extraction);
    const otherDate = dateOf(record.extraction);
    return (
      (gross !== null && otherGross !== null && gross !== otherGross) ||
      (date !== null && otherDate !== null && date !== otherDate)
    );
  };
  const copies = sameNumber.filter((record) => !changed(record));
  const revisions = sameNumber.filter(changed);
  const sameDateAndTotal =
    gross !== null && gross !== 0 && date !== null
      ? history.filter(
          (record) =>
            docType(record.extraction) === type &&
            documentNumberKey(asRecord(record.extraction).invoiceNumber) !==
              number &&
            grossMinor(record.extraction) === gross &&
            dateOf(record.extraction) === date,
        )
      : [];
  const credited = input.validation?.identity.creditsInvoiceId ?? null;
  const validationDuplicate = input.validation?.identity.duplicateOf ?? null;

  if (copies.length > 0) {
    duplicate = {
      outcome: "likely_duplicate",
      message: `The same ${label(extraction)} from ${name}, with the same date and total, was already received.`,
      evidence: copies.map((record) => ({
        invoiceId: record.id,
        reason: "same_number",
      })),
    };
  } else if (revisions.length > 0) {
    duplicate = {
      outcome: "revision",
      message: `${name} already sent ${label(extraction)} with a different date or total; this looks like a revised copy, not a new bill.`,
      evidence: revisions.map((record) => ({
        invoiceId: record.id,
        reason: "same_number_changed",
      })),
    };
  } else if (!resolved && validationDuplicate) {
    duplicate = {
      outcome: "likely_duplicate",
      message: `The same ${label(extraction)} with the same printed supplier was already received. ${supplier.message}`,
      evidence: [{ invoiceId: validationDuplicate, reason: "same_number" }],
    };
  } else if (type === "credit_note" && credited) {
    duplicate = {
      outcome: "credit_note",
      message: `A credit note against ${label(history.find((record) => record.id === credited)?.extraction ?? { invoiceNumber: asRecord(extraction).originalInvoiceNumber })}, not a duplicate.`,
      evidence: [{ invoiceId: credited, reason: "credited_invoice" }],
    };
  } else if (sameDateAndTotal.length > 0) {
    duplicate = {
      outcome: "likely_duplicate",
      message: `${name} already sent a document with the same date and total under a different number; check it is not the same bill.`,
      evidence: sameDateAndTotal.map((record) => ({
        invoiceId: record.id,
        reason: "same_date_and_total",
      })),
    };
  } else if (!resolved) {
    duplicate = {
      outcome: "insufficient_evidence",
      message: `${supplier.message} ${UNRESOLVED_HISTORY}`,
      evidence: [],
    };
  } else if (type === "credit_note") {
    duplicate = {
      outcome: "credit_note",
      message:
        "A credit note; the invoice it credits was not found from this supplier.",
      evidence: [],
    };
  } else {
    duplicate = {
      outcome: "none",
      message:
        input.earlierInvoices > 0
          ? `No earlier document from ${name} has this number, or this date and total.`
          : `No earlier documents from ${name} to compare with.`,
      evidence: [],
    };
  }

  // --- Bank details against the supplier's own history.
  const current = bankAccountKeysOf(extraction);
  const currentMasked = maskBankAccount(current);
  let bankDetails: SupplierChecks["bankDetails"];
  const withBank = history
    .map((record) => ({ record, keys: bankAccountKeysOf(record.extraction) }))
    .filter(({ keys }) => hasBankAccount(keys));
  const comparable = withBank.filter(
    ({ keys }) => compareBank(current, keys) !== "incomparable",
  );
  if (!currentMasked) {
    bankDetails = {
      outcome: "not_present",
      message: "No bank details were read from this document.",
      current: null,
      evidence: [],
    };
  } else if (!resolved) {
    bankDetails = {
      outcome: "insufficient_evidence",
      message: `${supplier.message} ${UNRESOLVED_HISTORY}`,
      current: currentMasked,
      evidence: [],
    };
  } else if (comparable.length === 0) {
    bankDetails = {
      outcome: "insufficient_evidence",
      message:
        withBank.length === 0
          ? `No earlier document from ${name} has bank details to compare with.`
          : `Earlier bank details from ${name} are in a form that cannot be compared with these (IBAN against sort code and account).`,
      current: currentMasked,
      evidence: [],
    };
  } else {
    const latest = comparable[0]!;
    const latestMasked = maskBankAccount(latest.keys);
    const same = comparable.filter(
      ({ keys }) => compareBank(current, keys) === "same",
    );
    const earliestSame = same.at(-1);
    if (compareBank(current, latest.keys) === "same") {
      bankDetails = {
        outcome: "consistent",
        message: `The bank details (${describeBankAccount(currentMasked)}) match ${name}'s most recent ${label(latest.record.extraction)}.`,
        current: currentMasked,
        evidence: [
          {
            invoiceId: latest.record.id,
            reason: "latest_bank_details",
            bankAccount: latestMasked,
          },
          ...(earliestSame && earliestSame !== latest
            ? [
                {
                  invoiceId: earliestSame.record.id,
                  reason: "same_bank_details" as const,
                  bankAccount: maskBankAccount(earliestSame.keys),
                },
              ]
            : []),
        ],
      };
    } else {
      bankDetails = {
        outcome: "changed",
        message: `The bank details changed: this document has ${describeBankAccount(currentMasked)}, ${name}'s most recent ${label(latest.record.extraction)} had ${latestMasked ? describeBankAccount(latestMasked) : "other details"}. ${earliestSame ? `These details were used on ${label(earliestSame.record.extraction)} before.` : `${name} has not used these details before.`} Confirm the change with the supplier through a known contact before paying.`,
        current: currentMasked,
        evidence: [
          {
            invoiceId: latest.record.id,
            reason: "latest_bank_details",
            bankAccount: latestMasked,
          },
          ...(earliestSame
            ? [
                {
                  invoiceId: earliestSame.record.id,
                  reason: "same_bank_details" as const,
                  bankAccount: maskBankAccount(earliestSame.keys),
                },
              ]
            : []),
        ],
      };
    }
  }

  return {
    version: SUPPLIER_CHECKS_VERSION,
    checkedAt: (input.now ?? new Date()).toISOString(),
    supplier,
    known,
    duplicate,
    bankDetails,
    historyIds: unique([
      ...history.map((record) => record.id),
      ...(input.firstInvoice ? [input.firstInvoice.id] : []),
    ]),
  };
}
