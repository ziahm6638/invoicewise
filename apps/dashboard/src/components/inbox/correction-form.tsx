"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import {
  CORRECTABLE_FIELDS,
  type CorrectableField,
  applyInvoiceCorrection,
} from "@invoicewise/documents/correction";
import { Alert, AlertDescription, AlertTitle } from "@invoicewise/ui/alert";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { RadioGroup, RadioGroupItem } from "@invoicewise/ui/radio-group";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { type InvoiceDetail, useInvalidateInvoice } from "./invoice-workflow";

const PROVIDER_NAME: Record<string, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

type FieldKind = "text" | "date" | "amount" | "rate" | "documentType" | "tax";

const FIELDS: Record<
  CorrectableField,
  { label: string; kind: FieldKind; group: string }
> = {
  documentType: {
    label: "Document type",
    kind: "documentType",
    group: "Document",
  },
  supplierName: { label: "Supplier", kind: "text", group: "Document" },
  supplierAddress: {
    label: "Supplier address",
    kind: "text",
    group: "Document",
  },
  supplierVatNumber: { label: "VAT number", kind: "text", group: "Document" },
  supplierCompanyNumber: {
    label: "Company number",
    kind: "text",
    group: "Document",
  },
  invoiceNumber: { label: "Invoice number", kind: "text", group: "Document" },
  originalInvoiceNumber: {
    label: "Credits invoice number",
    kind: "text",
    group: "Document",
  },
  invoiceDate: { label: "Invoice date", kind: "date", group: "Dates" },
  dueDate: { label: "Due date", kind: "date", group: "Dates" },
  currency: { label: "Currency (ISO code)", kind: "text", group: "Amounts" },
  netAmount: { label: "Net", kind: "amount", group: "Amounts" },
  discountAmount: { label: "Discount", kind: "amount", group: "Amounts" },
  vatAmount: { label: "VAT", kind: "amount", group: "Amounts" },
  grossAmount: { label: "Gross", kind: "amount", group: "Amounts" },
  taxRate: { label: "VAT rate (%)", kind: "rate", group: "Amounts" },
  amountsIncludeTax: {
    label: "Line amounts include VAT",
    kind: "tax",
    group: "Amounts",
  },
  description: { label: "Description", kind: "text", group: "References" },
  purchaseOrderReference: {
    label: "PO reference",
    kind: "text",
    group: "References",
  },
  paymentReference: {
    label: "Payment reference",
    kind: "text",
    group: "References",
  },
  accountName: {
    label: "Account name",
    kind: "text",
    group: "Payment details",
  },
  accountNumber: {
    label: "Account number",
    kind: "text",
    group: "Payment details",
  },
  sortCode: { label: "Sort code", kind: "text", group: "Payment details" },
  iban: { label: "IBAN", kind: "text", group: "Payment details" },
  bic: { label: "BIC", kind: "text", group: "Payment details" },
};

const GROUPS = [
  "Document",
  "Dates",
  "Amounts",
  "References",
  "Payment details",
];

const BANK = new Set<CorrectableField>([
  "accountName",
  "accountNumber",
  "sortCode",
  "iban",
  "bic",
]);

const asInput = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "boolean"
      ? value
        ? "yes"
        : "no"
      : String(value);

/** The form's text back into the canonical record's value type. */
const fromInput = (field: CorrectableField, text: string) => {
  const kind = FIELDS[field].kind;
  const value = text.trim();
  if (!value) return null;
  if (kind === "amount" || kind === "rate") {
    return Number(value.replace(/,/g, ""));
  }
  if (kind === "tax") return value === "yes";
  return value;
};

const outcomeMessage: Record<string, string> = {
  post_queued: "The corrected invoice is queued to be sent to accounting.",
  not_scheduled: "Nothing was sent to accounting.",
  admin_required:
    "Sending it to accounting again needs an admin: ask one to retry delivery.",
  held: "The delivery rules hold the corrected invoice; the reasons are under Delivery.",
  bill_kept: "The bill in your accounting software was left as it was.",
  bill_update_queued:
    "The same bill in your accounting software is being updated. No new bill is created.",
};

/**
 * Correct extracted fields against the original document. The same rules
 * the server applies (`applyInvoiceCorrection`) check the values before they
 * are sent, and the panel says what the save will do downstream.
 */
export function CorrectionForm({
  invoice,
  onDone,
}: {
  invoice: InvoiceDetail;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const invalidate = useInvalidateInvoice();
  const permissions = useTeamPermissions();
  const extraction = (invoice.extraction ?? {}) as Record<string, unknown>;
  const bank = (extraction.bankDetails ?? {}) as Record<string, unknown>;
  const initial = useMemo(
    () =>
      Object.fromEntries(
        CORRECTABLE_FIELDS.map((field) => [
          field,
          asInput(BANK.has(field) ? bank[field] : extraction[field]),
        ]),
      ) as Record<CorrectableField, string>,
    [invoice.id, invoice.processingRevision],
  );
  const [values, setValues] = useState(initial);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<"keep_bill" | "update_bill" | null>(
    null,
  );
  const [serverError, setServerError] = useState<string | null>(null);

  const posted = Boolean(invoice.accountingProviderId);
  const provider = invoice.accountingProvider
    ? PROVIDER_NAME[invoice.accountingProvider]
    : "your accounting software";
  const edited = CORRECTABLE_FIELDS.filter(
    (field) => values[field] !== initial[field],
  );
  const checked = applyInvoiceCorrection(
    invoice.extraction,
    Object.fromEntries(
      edited.map((field) => [field, fromInput(field, values[field])]),
    ),
    "preview",
  );
  const errors = new Map(
    checked.ok
      ? []
      : checked.errors.map((error) => [error.field, error.message] as const),
  );
  const changes = checked.ok ? checked.changes : [];
  const reasonOk = reason.trim().length >= 3;
  const outcomeOk = !posted || outcome !== null;
  const canSubmit = checked.ok && reasonOk && outcomeOk;

  const correct = useMutation(
    trpc.inbox.correct.mutationOptions({
      onSuccess: async (result) => {
        await invalidate(invoice.id);
        toast({
          title: `Correction ${result.version} saved`,
          description: `Validation: ${result.validationStatus.replace("_", " ")}. ${outcomeMessage[result.accounting] ?? ""}`,
          variant: "success",
        });
        onDone();
      },
      onError: (error) => {
        setServerError(error.message);
        if (error.data?.code === "CONFLICT") void invalidate(invoice.id);
      },
    }),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!checked.ok || !canSubmit) return;
    setServerError(null);
    correct.mutate({
      id: invoice.id,
      revision: invoice.processingRevision,
      reason: reason.trim(),
      changes: Object.fromEntries(
        checked.changes.map((change) => [change.field, change.to]),
      ),
      accountingOutcome: outcome ?? undefined,
    });
  };

  const downstream = [
    "Validation runs again on the corrected values.",
    "The values as read stay in the history, with your name, the time and your reason.",
    "Any webhook endpoints receive the corrected invoice as a new revision.",
    posted
      ? outcome === "update_bill"
        ? `The same bill in ${provider} is updated with the corrected values. No second bill is created.`
        : outcome === "keep_bill"
          ? `The bill in ${provider} stays as it was sent. Change it there yourself if it needs to match.`
          : `This invoice is already a bill in ${provider}: choose below what happens to it.`
      : invoice.accountingPostStatus &&
          invoice.accountingPostStatus !== "queued" &&
          !permissions.postToAccounting
        ? "It is not sent to accounting again until an admin retries delivery."
        : "If an accounting connection is active and the corrected invoice passes validation, it is sent to accounting.",
    "The answers to your questions are kept; rerun the questions afterwards to judge the corrected values.",
  ];

  return (
    <form onSubmit={submit} className="space-y-6" aria-label="Correct fields">
      <p className="text-xs text-muted-foreground">
        Compare with the original document and change only what was read
        wrongly. Line items cannot be corrected here.
      </p>
      {GROUPS.map((group) => (
        <fieldset key={group}>
          <legend className="text-sm font-semibold">{group}</legend>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 2xl:grid-cols-3">
            {CORRECTABLE_FIELDS.filter(
              (field) => FIELDS[field].group === group,
            ).map((field) => {
              const { label, kind } = FIELDS[field];
              const id = `correct-${field}`;
              const error = edited.includes(field) ? errors.get(field) : null;
              const changed = changes.some((change) => change.field === field);
              return (
                <div key={field} className="min-w-0 space-y-1">
                  <Label htmlFor={id} className="text-xs text-muted-foreground">
                    {label}
                    {changed && (
                      <span className="ml-1.5 text-sky-700 dark:text-sky-300">
                        · Changed
                      </span>
                    )}
                  </Label>
                  {kind === "documentType" || kind === "tax" ? (
                    <select
                      id={id}
                      className="flex h-9 w-full border bg-transparent px-3 text-sm"
                      value={values[field]}
                      onChange={(event) =>
                        setValues({ ...values, [field]: event.target.value })
                      }
                    >
                      <option value="">Not stated</option>
                      {kind === "documentType" ? (
                        <>
                          <option value="invoice">Invoice</option>
                          <option value="credit_note">Credit note</option>
                        </>
                      ) : (
                        <>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </>
                      )}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={kind === "date" ? "date" : "text"}
                      inputMode={
                        kind === "amount" || kind === "rate"
                          ? "decimal"
                          : undefined
                      }
                      value={values[field]}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? `${id}-error` : undefined}
                      onChange={(event) =>
                        setValues({ ...values, [field]: event.target.value })
                      }
                      autoComplete="off"
                    />
                  )}
                  {error && (
                    <p id={`${id}-error`} className="text-xs text-destructive">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      {posted && (
        <fieldset>
          <legend className="text-sm font-semibold">
            The bill in {provider}
          </legend>
          <RadioGroup
            className="mt-2 space-y-2"
            value={outcome ?? ""}
            onValueChange={(value) =>
              setOutcome(value as "keep_bill" | "update_bill")
            }
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="keep_bill" id="outcome-keep" />
              <Label htmlFor="outcome-keep" className="text-sm font-normal">
                Keep the bill as it is
                <span className="block text-xs text-muted-foreground">
                  Only InvoiceWise's record changes.
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem
                value="update_bill"
                id="outcome-update"
                disabled={!permissions.postToAccounting}
              />
              <Label htmlFor="outcome-update" className="text-sm font-normal">
                Update the same bill in {provider}
                <span className="block text-xs text-muted-foreground">
                  {permissions.postToAccounting
                    ? `Bill ${invoice.accountingProviderId} is changed in place; no new bill is created.`
                    : "Only an admin can change the bill."}
                </span>
              </Label>
            </div>
          </RadioGroup>
        </fieldset>
      )}

      <div className="space-y-1">
        <Label htmlFor="correct-reason" className="text-sm font-semibold">
          Reason
        </Label>
        <Textarea
          id="correct-reason"
          value={reason}
          maxLength={500}
          placeholder="For example: the gross total was read from the balance-due line"
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      <div className="border bg-secondary/30 p-3">
        <p className="text-sm font-medium">What happens when you save</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {downstream.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {(serverError || (!checked.ok && errors.has(null) && edited.length)) && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden className="size-4" />
          <AlertTitle>The correction was not saved</AlertTitle>
          <AlertDescription>{serverError ?? errors.get(null)}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || correct.isPending}>
          {correct.isPending
            ? "Saving…"
            : changes.length
              ? `Save ${changes.length === 1 ? "1 change" : `${changes.length} changes`}`
              : "Save correction"}
        </Button>
      </div>
    </form>
  );
}
