"use client";

import { useTRPC } from "@/trpc/client";
import type {
  RouterInputs,
  RouterOutputs,
} from "@invoicewise/api/trpc/routers/_app";
import {
  AUTHORIZATION_SOURCE_TYPES,
  AUTHORIZATION_TAX_BASES,
} from "@invoicewise/documents/authorization-source";
import { Button } from "@invoicewise/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { taxBasisLabel, typeLabel } from "./shared";

type SourceInput = RouterInputs["authorizationSources"]["create"]["source"];
type Version = RouterOutputs["authorizationSources"]["get"]["current"];

type LineDraft = {
  key: string;
  reference: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
};

const MATCH = "__match__";
const NOT_STATED = "__not_stated__";

const newLine = (): LineDraft => ({
  key: crypto.randomUUID(),
  reference: "",
  description: "",
  quantity: "",
  unitPrice: "",
  amount: "",
});

const blank = (value: string) => (value.trim() === "" ? null : value.trim());

/**
 * Create a source, or amend one: an amendment states the terms as they now
 * stand and is recorded as a new version; the earlier version is kept.
 */
export function SourceForm({
  open,
  onOpenChange,
  amend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amend?: { id: string; type: string; reference: string; current: Version };
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = amend?.current;

  const [type, setType] = useState(amend?.type ?? "purchase_order");
  const [reference, setReference] = useState(amend?.reference ?? "");
  const [title, setTitle] = useState(current?.title ?? "");
  const [scope, setScope] = useState(current?.scope ?? "");
  const [supplierChoice, setSupplierChoice] = useState(MATCH);
  const [supplierName, setSupplierName] = useState(
    current?.suppliedSupplier.name ?? "",
  );
  const [vatNumber, setVatNumber] = useState(
    current?.suppliedSupplier.vatNumber ?? "",
  );
  const [companyNumber, setCompanyNumber] = useState(
    current?.suppliedSupplier.companyNumber ?? "",
  );
  const [currency, setCurrency] = useState(current?.currency ?? "");
  const [taxBasis, setTaxBasis] = useState(current?.taxBasis ?? NOT_STATED);
  const [issuedOn, setIssuedOn] = useState(current?.issuedOn ?? "");
  const [startsOn, setStartsOn] = useState(current?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(current?.endsOn ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [total, setTotal] = useState(
    current && current.lines.length === 0 ? current.authorizedTotal : "",
  );
  const [changeReason, setChangeReason] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(
    current?.lines.map((line) => ({
      key: crypto.randomUUID(),
      reference: line.reference ?? "",
      description: line.description,
      quantity: line.quantity ?? "",
      unitPrice: line.unitPrice ?? "",
      amount: line.amount,
    })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);

  const suppliers = useQuery(
    trpc.suppliers.list.queryOptions(undefined, { enabled: open }),
  );

  const done = async (message: string, outcome: string) => {
    await queryClient.invalidateQueries({
      queryKey: trpc.authorizationSources.pathKey(),
    });
    toast({
      title: outcome === "unchanged" ? "Nothing changed" : message,
      duration: 3500,
    });
    onOpenChange(false);
  };
  const create = useMutation(
    trpc.authorizationSources.create.mutationOptions({
      onSuccess: (result) => done("Source created", result.outcome),
      onError: (failure) => setError(failure.message),
    }),
  );
  const amendMutation = useMutation(
    trpc.authorizationSources.amend.mutationOptions({
      onSuccess: (result) =>
        done(`Saved as version ${result.version}`, result.outcome),
      onError: (failure) => setError(failure.message),
    }),
  );
  const isSaving = create.isPending || amendMutation.isPending;

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((all) =>
      all.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );

  const submit = () => {
    setError(null);
    const source: SourceInput = {
      type,
      reference,
      title: blank(title),
      scope: blank(scope),
      supplier: {
        id: supplierChoice === MATCH ? null : supplierChoice,
        name: blank(supplierName),
        vatNumber: blank(vatNumber),
        companyNumber: blank(companyNumber),
      },
      currency: blank(currency),
      taxBasis: taxBasis === NOT_STATED ? null : taxBasis,
      issuedOn: blank(issuedOn),
      startsOn: blank(startsOn),
      endsOn: blank(endsOn),
      effectiveFrom: blank(effectiveFrom),
      authorizedTotal: blank(total),
      changeReason: blank(changeReason),
      lines: lines.map((line) => ({
        reference: blank(line.reference),
        description: blank(line.description),
        quantity: blank(line.quantity),
        unitPrice: blank(line.unitPrice),
        amount: blank(line.amount),
      })),
    };
    if (amend) amendMutation.mutate({ id: amend.id, source });
    else create.mutate({ source });
  };

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[760px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {amend ? `Amend ${amend.reference}` : "New authorization source"}
          </DialogTitle>
          <DialogDescription>
            {amend
              ? "State the terms as they now stand. This is saved as a new version; the earlier versions stay as they were."
              : "A job, purchase order or contract that invoices will be checked against."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="source-type">Type</Label>
              <Select
                value={type}
                onValueChange={setType}
                disabled={Boolean(amend)}
              >
                <SelectTrigger id="source-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTHORIZATION_SOURCE_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {typeLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {field("source-reference", "Reference", reference, setReference, {
              placeholder: "PO-1001",
              disabled: Boolean(amend),
              required: true,
            })}
            {field("source-title", "Title", title, setTitle, {
              placeholder: "Kitchen refit",
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source-scope">Scope of work</Label>
            <Textarea
              id="source-scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder="What is authorized, where, and any limits"
              maxLength={4_000}
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Supplier</legend>
            <Select value={supplierChoice} onValueChange={setSupplierChoice}>
              <SelectTrigger aria-label="Workspace supplier">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MATCH}>
                  {current?.supplier
                    ? `Keep ${current.supplier.name ?? "the linked supplier"} (or match the details below)`
                    : "Match by the details below"}
                </SelectItem>
                {suppliers.data?.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid gap-4 md:grid-cols-3">
              {field("supplier-name", "Name", supplierName, setSupplierName)}
              {field("supplier-vat", "VAT number", vatNumber, setVatNumber)}
              {field(
                "supplier-company",
                "Company number",
                companyNumber,
                setCompanyNumber,
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              A VAT or company number links the source to the supplier that
              holds it; a name links only when one supplier has it. Otherwise
              the source is marked as having an unknown supplier.
            </p>
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            {field("source-currency", "Currency", currency, setCurrency, {
              placeholder: "GBP",
              maxLength: 3,
            })}
            <div className="space-y-1.5">
              <Label htmlFor="source-tax">Tax basis</Label>
              <Select value={taxBasis} onValueChange={setTaxBasis}>
                <SelectTrigger id="source-tax">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_STATED}>Not stated</SelectItem>
                  {AUTHORIZATION_TAX_BASES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {taxBasisLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            {field("source-issued", "Issued", issuedOn, setIssuedOn, {
              type: "date",
            })}
            {field("source-starts", "Starts", startsOn, setStartsOn, {
              type: "date",
            })}
            {field("source-ends", "Ends", endsOn, setEndsOn, { type: "date" })}
            {field(
              "source-effective",
              amend ? "Amendment effective" : "Effective from",
              effectiveFrom,
              setEffectiveFrom,
              { type: "date" },
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Authorized lines</legend>
            {lines.map((line, index) => (
              <div
                key={line.key}
                className="grid grid-cols-[70px_1fr_80px_100px_110px_auto] items-end gap-2"
              >
                <Input
                  aria-label={`Line ${index + 1} reference`}
                  placeholder="Ref"
                  value={line.reference}
                  onChange={(event) =>
                    updateLine(line.key, { reference: event.target.value })
                  }
                />
                <Input
                  aria-label={`Line ${index + 1} description`}
                  placeholder="Description"
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.key, { description: event.target.value })
                  }
                />
                <Input
                  aria-label={`Line ${index + 1} quantity`}
                  placeholder="Qty"
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) =>
                    updateLine(line.key, { quantity: event.target.value })
                  }
                />
                <Input
                  aria-label={`Line ${index + 1} unit price`}
                  placeholder="Unit price"
                  inputMode="decimal"
                  value={line.unitPrice}
                  onChange={(event) =>
                    updateLine(line.key, { unitPrice: event.target.value })
                  }
                />
                <Input
                  aria-label={`Line ${index + 1} amount`}
                  placeholder="Amount"
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(event) =>
                    updateLine(line.key, { amount: event.target.value })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setLines((all) =>
                      all.filter((item) => item.key !== line.key),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((all) => [...all, newLine()])}
            >
              Add line
            </Button>
            <p className="text-xs text-muted-foreground">
              A line's amount can be left empty when quantity and unit price are
              given.
            </p>
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            {field("source-total", "Authorized total", total, setTotal, {
              inputMode: "decimal",
              placeholder: lines.length > 0 ? "Sum of the lines" : "14400.00",
            })}
            {amend &&
              field(
                "source-reason",
                "Reason for the change",
                changeReason,
                setChangeReason,
                { placeholder: "Variation 2: extra boards" },
              )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !reference.trim()}>
              {isSaving ? "Saving…" : amend ? "Save amendment" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
