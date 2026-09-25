"use client";

import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Button } from "@invoicewise/ui/button";
import { Checkbox } from "@invoicewise/ui/checkbox";
import { Label } from "@invoicewise/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import { Switch } from "@invoicewise/ui/switch";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

type Setup = NonNullable<RouterOutputs["accounting"]["setup"]>;

/**
 * What QuickBooks needs before InvoiceWise creates anything there: the
 * expense account every line posts to, the purchase tax codes it may choose
 * between (companies outside the US), and the explicit opt-in to automatic
 * bills, which QuickBooks creates open and unpaid because it has no drafts.
 */
export function QuickBooksSetup() {
  const trpc = useTRPC();
  const { data, error, isPending } = useQuery(
    trpc.accounting.setup.queryOptions(),
  );

  if (isPending) {
    return (
      <p className="text-xs text-muted-foreground">
        Reading the QuickBooks company…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-xs text-destructive">
        Could not read the QuickBooks company: {error.message}
      </p>
    );
  }
  if (!data || data.provider !== "quickbooks") return null;
  return <SetupForm setup={data} />;
}

function SetupForm({ setup }: { setup: Setup }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expenseAccountId, setExpenseAccountId] = useState(
    setup.settings.expenseAccountId ?? "",
  );
  const [taxCodeIds, setTaxCodeIds] = useState<string[]>(
    setup.settings.taxCodeIds ?? [],
  );
  const [autoPost, setAutoPost] = useState(Boolean(setup.autoPostEnabledAt));
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setAutoPost(Boolean(setup.autoPostEnabledAt));
  }, [setup.autoPostEnabledAt]);

  const save = useMutation(
    trpc.accounting.updateSettings.mutationOptions({
      onSuccess: () => {
        toast({ duration: 3500, variant: "success", title: "Saved" });
        setConfirmed(false);
        queryClient.invalidateQueries({
          queryKey: trpc.accounting.setup.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.accounting.get.queryKey(),
        });
      },
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: "The QuickBooks settings were not saved",
          description: error.message,
        }),
    }),
  );

  const company = setup.company;
  const companyLabel = `${company?.name ?? "the connected company"} (company ID ${setup.organisationId ?? company?.realmId})`;
  const turningOn = autoPost && !setup.autoPostEnabledAt;
  const canSave =
    !save.isPending &&
    (!autoPost || Boolean(expenseAccountId)) &&
    (!turningOn || confirmed);

  return (
    <div className="mt-3 flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quickbooks-expense-account" className="text-xs">
          Expense account for bill lines
        </Label>
        <Select value={expenseAccountId} onValueChange={setExpenseAccountId}>
          <SelectTrigger id="quickbooks-expense-account" className="text-xs">
            <SelectValue placeholder="Choose an expense account" />
          </SelectTrigger>
          <SelectContent>
            {setup.accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!expenseAccountId && (
          <span className="text-xs text-destructive">
            Required: nothing is sent to QuickBooks until an expense account is
            chosen.
          </span>
        )}
      </div>

      {company?.purchaseTax ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium">Purchase tax codes</legend>
          <span className="text-xs text-muted-foreground">
            Each bill gets the tax code whose rate reproduces the invoice's tax.
            Tick the codes to prefer where several share a rate (for example 0%
            zero-rated or exempt); an invoice no code matches is not sent.
          </span>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {setup.taxCodes.map((code) => (
              <Label
                key={code.id}
                className="flex items-center gap-2 text-xs font-normal"
              >
                <Checkbox
                  checked={taxCodeIds.includes(code.id)}
                  onCheckedChange={(checked) =>
                    setTaxCodeIds((current) =>
                      checked
                        ? [...current, code.id]
                        : current.filter((id) => id !== code.id),
                    )
                  }
                />
                {code.name} · {code.rate}%
              </Label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-xs text-muted-foreground">
          This is a US company, so bills carry no tax code: an invoice's tax is
          added as its own line on the same expense account, and the bill total
          matches the invoice.
        </p>
      )}

      {company && (
        <p className="text-xs text-muted-foreground">
          Home currency {company.homeCurrency ?? "unknown"}
          {company.multiCurrency
            ? "; multicurrency is on, so invoices in other currencies post in their own currency."
            : "; invoices in other currencies are not sent until multicurrency is on in QuickBooks."}{" "}
          Suppliers are matched to QuickBooks vendors by name, and a missing
          vendor is created. Credit notes become vendor credits.
        </p>
      )}

      <div className="flex flex-col gap-2 border-t pt-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="quickbooks-auto-post" className="text-xs">
            Create bills automatically
          </Label>
          <Switch
            id="quickbooks-auto-post"
            checked={autoPost}
            onCheckedChange={setAutoPost}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          QuickBooks has no draft bills. When this is on, every invoice the
          delivery rules let through is created as an open, unpaid bill (a
          credit note as a vendor credit) in {companyLabel}. Nothing is paid or
          approved for payment. When it is off, nothing is created
          automatically; you can still send an individual invoice yourself.
        </span>
        {turningOn && (
          <Label className="flex items-start gap-2 text-xs font-normal">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            I confirm InvoiceWise should create open, unpaid bills in{" "}
            {companyLabel}.
          </Label>
        )}
      </div>

      <div>
        <Button
          size="sm"
          className="text-xs"
          disabled={!canSave}
          onClick={() =>
            save.mutate({
              provider: "quickbooks",
              expenseAccountId: expenseAccountId || null,
              taxCodeIds,
              autoPost,
              confirmOrganisationId: turningOn ? setup.organisationId : null,
            })
          }
        >
          Save QuickBooks settings
        </Button>
      </div>
    </div>
  );
}
