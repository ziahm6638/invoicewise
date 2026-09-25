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
type Provider = Setup["provider"];

const NAME: Record<Provider, string> = {
  xero: "Xero",
  quickbooks: "QuickBooks",
};

/**
 * What a connected provider needs before InvoiceWise creates anything there:
 * for Xero the organisation to post to (one authorisation can reach
 * several), the account every line posts to, the purchase tax codes it may
 * choose between, and the explicit opt-in to automatic posting confirming
 * the organisation. QuickBooks creates open, unpaid bills (it has no
 * drafts); Xero creates drafts awaiting approval.
 */
export function AccountingSetup({ provider }: { provider: Provider }) {
  const trpc = useTRPC();
  const { data, error, isPending } = useQuery(
    trpc.accounting.setup.queryOptions(),
  );

  if (isPending) {
    return (
      <p className="text-xs text-muted-foreground">
        Reading the {NAME[provider]} organisation…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-xs text-destructive">
        Could not read the {NAME[provider]} organisation: {error.message}
      </p>
    );
  }
  if (!data || data.provider !== provider) return null;
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-md border p-4">
      {provider === "xero" && <XeroOrganisation setup={data} />}
      <SetupForm key={data.organisationId ?? ""} setup={data} />
    </div>
  );
}

function useRefresh() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({
      queryKey: trpc.accounting.setup.queryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.accounting.get.queryKey(),
    });
  };
}

/** The Xero organisation bills go to, among those the connection reaches. */
function XeroOrganisation({ setup }: { setup: Setup }) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const refresh = useRefresh();
  const select = useMutation(
    trpc.accounting.selectOrganisation.mutationOptions({
      onSuccess: () => {
        toast({
          duration: 3500,
          variant: "success",
          title: "Organisation changed",
          description:
            "Choose its account and switch on automatic bills again.",
        });
        refresh();
      },
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: "The organisation was not changed",
          description: error.message,
        }),
    }),
  );
  if (setup.organisations.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        This connection reaches one Xero organisation. To use another, reconnect
        and authorise it in Xero.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="xero-organisation" className="text-xs">
        Xero organisation for bills
      </Label>
      <Select
        value={setup.organisationId ?? ""}
        disabled={select.isPending}
        onValueChange={(organisationId) =>
          select.mutate({ provider: "xero", organisationId })
        }
      >
        <SelectTrigger id="xero-organisation" className="text-xs">
          <SelectValue placeholder="Choose an organisation" />
        </SelectTrigger>
        <SelectContent>
          {setup.organisations.map((organisation) => (
            <SelectItem key={organisation.id} value={organisation.id}>
              {organisation.name ?? organisation.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">
        This connection reaches {setup.organisations.length} organisations.
        Changing it clears the account, tax rates and automatic bills chosen for
        the current one.
      </span>
    </div>
  );
}

function SetupForm({ setup }: { setup: Setup }) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const refresh = useRefresh();
  const name = NAME[setup.provider];
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
        refresh();
      },
      onError: (error) =>
        toast({
          duration: 6000,
          variant: "error",
          title: `The ${name} settings were not saved`,
          description: error.message,
        }),
    }),
  );

  const company = setup.company;
  const organisation = setup.organisation;
  const organisationLabel = `${organisation?.name ?? company?.name ?? setup.organisationName ?? "the connected company"} (${setup.provider === "xero" ? "organisation" : "company"} ID ${setup.organisationId ?? company?.realmId})`;
  const turningOn = autoPost && !setup.autoPostEnabledAt;
  const canSave =
    !save.isPending &&
    (!autoPost || Boolean(expenseAccountId)) &&
    (!turningOn || confirmed);
  const taxesPurchases = setup.provider === "xero" || company?.purchaseTax;
  const records =
    setup.provider === "xero"
      ? "a draft bill (a credit note as a draft credit note) awaiting approval"
      : "an open, unpaid bill (a credit note as a vendor credit)";

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${setup.provider}-expense-account`}
          className="text-xs"
        >
          {setup.provider === "xero" ? "Account" : "Expense account"} for bill
          lines
        </Label>
        <Select value={expenseAccountId} onValueChange={setExpenseAccountId}>
          <SelectTrigger
            id={`${setup.provider}-expense-account`}
            className="text-xs"
          >
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
            Required: nothing is sent to {name} until an expense account is
            chosen.
          </span>
        )}
      </div>

      {taxesPurchases ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium">
            Purchase tax {setup.provider === "xero" ? "rates" : "codes"}
          </legend>
          <span className="text-xs text-muted-foreground">
            Each bill gets the tax {setup.provider === "xero" ? "rate" : "code"}{" "}
            that reproduces the invoice's tax. Tick the ones to prefer where
            several share a rate (for example 0% zero-rated, exempt or no VAT);
            an invoice nothing matches, or where the choice is ambiguous, is not
            sent and says why.
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

      {organisation ? (
        <p className="text-xs text-muted-foreground">
          Base currency {organisation.baseCurrency ?? "unknown"}; invoices in{" "}
          {organisation.currencies.join(", ") || "it"} are sent, others wait
          until the currency is added in Xero. Suppliers are matched to Xero
          contacts by name, and a missing contact is created. Credit notes
          become draft credit notes.
        </p>
      ) : company ? (
        <p className="text-xs text-muted-foreground">
          Home currency {company.homeCurrency ?? "unknown"}
          {company.multiCurrency
            ? "; multicurrency is on, so invoices in other currencies post in their own currency."
            : "; invoices in other currencies are not sent until multicurrency is on in QuickBooks."}{" "}
          Suppliers are matched to QuickBooks vendors by name, and a missing
          vendor is created. Credit notes become vendor credits.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t pt-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={`${setup.provider}-auto-post`} className="text-xs">
            Create bills automatically
          </Label>
          <Switch
            id={`${setup.provider}-auto-post`}
            checked={autoPost}
            onCheckedChange={setAutoPost}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          When this is on, every invoice the delivery rules let through is
          created as {records} in {organisationLabel}. Nothing is paid or
          approved for payment. When it is off, nothing is created
          automatically. An invoice whose queued post was stopped can still be
          sent from that invoice.
        </span>
        {turningOn && (
          <Label className="flex items-start gap-2 text-xs font-normal">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
            />
            I confirm InvoiceWise should create{" "}
            {setup.provider === "xero" ? "draft bills" : "open, unpaid bills"}{" "}
            in {organisationLabel}.
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
              provider: setup.provider,
              expenseAccountId: expenseAccountId || null,
              taxCodeIds,
              autoPost,
              confirmOrganisationId: turningOn ? setup.organisationId : null,
            })
          }
        >
          Save {name} settings
        </Button>
      </div>
    </>
  );
}
