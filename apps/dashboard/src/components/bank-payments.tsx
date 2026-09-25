"use client";

import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Checkbox } from "@invoicewise/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
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
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Connection =
  RouterOutputs["bankPayments"]["overview"]["connections"][number];

const STATUS: Record<string, string> = {
  pending: "Waiting for the bank",
  active: "Connected",
  reconnect_required: "Reconnect needed",
  failed: "Not completed",
  disconnected: "Disconnected",
};

const CONSENT: Record<string, string> = {
  pending: "not yet given at the bank",
  active: "active",
  expired: "expired",
  revoked: "revoked at the bank",
  withdrawn: "withdrawn",
};

const TX_STATUS: Record<string, string> = {
  pending: "Pending",
  posted: "Posted",
  superseded: "Replaced by posted",
  reversed: "Reversed",
};

const money = (amount: string, currency: string) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(
      Number(amount),
    );
  } catch {
    return `${amount} ${currency}`;
  }
};

function ConsentFields({
  periods,
  period,
  onPeriod,
  accepted,
  onAccepted,
}: {
  periods: number[];
  period: number;
  onPeriod: (value: number) => void;
  accepted: boolean;
  onAccepted: (value: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Label htmlFor="consent-period" className="text-sm">
          Consent for
        </Label>
        <Select
          value={String(period)}
          onValueChange={(value) => onPeriod(Number(value))}
        >
          <SelectTrigger id="consent-period" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {periods.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="consent-accepted"
          checked={accepted}
          onCheckedChange={(checked) => onAccepted(checked === true)}
        />
        <Label htmlFor="consent-accepted" className="text-sm font-normal">
          I allow InvoiceWise to read this bank's accounts and transactions,
          through Salt Edge, for {period} days, to match payments to invoices.
          It cannot move money. I sign in at my bank; InvoiceWise never sees
          my bank login. I can disconnect at any time.
        </Label>
      </div>
    </div>
  );
}

/**
 * Optional bank-payment reconciliation: turn it on, connect a bank with
 * explicit consent, and see each connection's consent, sync and failures.
 */
export function BankPayments() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: user } = useUserQuery();
  const { data } = useSuspenseQuery(trpc.bankPayments.overview.queryOptions());
  const [period, setPeriod] = useState<number>(data.defaultConsentDays);
  const [accepted, setAccepted] = useState(false);
  const [reconnecting, setReconnecting] = useState<Connection | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const completed = useRef(false);

  const format = (value: string) => formatDate(value, user?.dateFormat);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.bankPayments.overview.queryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.bankPayments.transactions.queryKey(),
      }),
    ]);
  const fail = (title: string) => (error: { message: string }) =>
    toast({ duration: 6000, variant: "error", title, description: error.message });

  const setEnabled = useMutation(
    trpc.bankPayments.setEnabled.mutationOptions({
      onSuccess: refresh,
      onError: fail("Bank payments could not be changed"),
    }),
  );
  const connect = useMutation(
    trpc.bankPayments.connect.mutationOptions({
      onSuccess: (session) => {
        window.location.assign(session.connectUrl);
      },
      onError: fail("Unable to start the bank connection"),
    }),
  );
  const reconnect = useMutation(
    trpc.bankPayments.reconnect.mutationOptions({
      onSuccess: (session) => {
        window.location.assign(session.connectUrl);
      },
      onError: fail("Unable to reconnect the bank"),
    }),
  );
  const complete = useMutation(
    trpc.bankPayments.complete.mutationOptions({
      onSuccess: (connection) => {
        toast({
          duration: 4000,
          variant: connection.status === "active" ? "success" : "error",
          title:
            connection.status === "active"
              ? "Bank connected. Transactions are being imported."
              : "The bank connection was not completed",
        });
        return refresh();
      },
      onError: fail("The bank connection could not be confirmed"),
      onSettled: () => router.replace("/settings/bank-payments"),
    }),
  );
  const disconnect = useMutation(
    trpc.bankPayments.disconnect.mutationOptions({
      onSuccess: () => {
        setDisconnecting(null);
        toast({ duration: 3500, variant: "success", title: "Bank disconnected" });
        return refresh();
      },
      onError: fail("Unable to disconnect the bank"),
    }),
  );
  const sync = useMutation(
    trpc.bankPayments.sync.mutationOptions({
      onSuccess: (result) => {
        toast({
          duration: 3500,
          variant: "success",
          title: result.queued ? "Sync queued" : "A sync is already queued",
        });
        return refresh();
      },
      onError: fail("Unable to sync"),
    }),
  );
  const transactions = useQuery(
    trpc.bankPayments.transactions.queryOptions(
      { page: 0 },
      { enabled: data.enabled },
    ),
  );

  // Back from the bank: Salt Edge appends connection_id (or error_class).
  useEffect(() => {
    const connectionId = searchParams.get("connection");
    if (!connectionId || completed.current) return;
    completed.current = true;
    complete.mutate({
      connectionId,
      providerConnectionId: searchParams.get("connection_id"),
      errorClass: searchParams.get("error_class"),
    });
  }, [searchParams, complete]);

  const busy =
    setEnabled.isPending ||
    connect.isPending ||
    reconnect.isPending ||
    disconnect.isPending ||
    complete.isPending;
  const active = data.connections.filter(
    (item) => item.status !== "disconnected" && item.status !== "failed",
  );
  const past = data.connections.filter(
    (item) => item.status === "disconnected" || item.status === "failed",
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Bank payments</CardTitle>
              <CardDescription>
                Optional. Match the payments in your bank account to invoices,
                so each invoice shows whether it was paid, part paid or not,
                with the transactions behind it. A payment counts on its own
                only when the transaction prints the invoice's number;
                anything less is proposed for you to confirm. Payment status
                is separate from matching invoices to jobs, purchase orders
                and contracts.
              </CardDescription>
            </div>
            <Switch
              aria-label="Use bank payments"
              checked={data.enabled}
              disabled={busy || (!data.available && !data.enabled)}
              onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
            />
          </div>
        </CardHeader>
        {!data.available && (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {data.unavailableReason}
          </p>
        )}
        {data.available && data.enabled && (
          <form
            className="space-y-4 px-6 pb-6"
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate({
                consentAccepted: true,
                consentPeriodDays: period as 30 | 60 | 90 | 180,
              });
            }}
          >
            <ConsentFields
              periods={data.consentPeriods}
              period={period}
              onPeriod={setPeriod}
              accepted={accepted}
              onAccepted={setAccepted}
            />
            <Button type="submit" disabled={busy || !accepted}>
              Connect a bank
            </Button>
          </form>
        )}
      </Card>

      {[...active, ...past].length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Connections</CardTitle>
          </CardHeader>
          <ul className="divide-y px-6 pb-4">
            {[...active, ...past].map((connection) => (
              <li key={connection.id} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {connection.bankName ?? "Bank"}
                    </span>
                    <Badge variant="tag-rounded" className="text-xs">
                      {STATUS[connection.status] ?? connection.status}
                    </Badge>
                  </div>
                  <div className="flex gap-2">
                    {connection.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || sync.isPending}
                        onClick={() =>
                          sync.mutate({ connectionId: connection.id })
                        }
                      >
                        Sync now
                      </Button>
                    )}
                    {(connection.status === "active" ||
                      connection.status === "reconnect_required") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setAccepted(false);
                          setReconnecting(connection);
                        }}
                      >
                        Reconnect
                      </Button>
                    )}
                    {connection.status !== "disconnected" &&
                      connection.status !== "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setDisconnecting(connection)}
                        >
                          Disconnect
                        </Button>
                      )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Consent {CONSENT[connection.consent.status] ?? connection.consent.status}
                  {connection.consent.givenByName
                    ? `, given by ${connection.consent.givenByName}`
                    : ""}{" "}
                  on {format(connection.consent.givenAt)} for{" "}
                  {connection.consent.periodDays} days
                  {connection.consent.expiresAt
                    ? `; expires ${format(connection.consent.expiresAt)}`
                    : ""}
                  . {connection.accounts} account
                  {connection.accounts === 1 ? "" : "s"},{" "}
                  {connection.transactions} transaction
                  {connection.transactions === 1 ? "" : "s"}.
                </p>
                {connection.sync.finishedAt || connection.sync.status ? (
                  <p className="text-xs text-muted-foreground">
                    Last sync{" "}
                    {connection.sync.status === "running"
                      ? "running now"
                      : connection.sync.status === "failed"
                        ? "failed"
                        : "succeeded"}
                    {connection.sync.finishedAt
                      ? ` ${formatDistanceToNow(new Date(connection.sync.finishedAt))} ago`
                      : ""}
                    {connection.sync.summary
                      ? ` · ${(connection.sync.summary as { postedNew?: number }).postedNew ?? 0} new, ${(connection.sync.summary as { pending?: number }).pending ?? 0} pending, ${(connection.sync.summary as { reversed?: number }).reversed ?? 0} reversed`
                      : ""}
                  </p>
                ) : null}
                {connection.sync.error && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {connection.sync.error}
                  </p>
                )}
                {connection.lastError && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {connection.lastError.message}
                    {connection.lastError.class
                      ? ` (${connection.lastError.class})`
                      : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.enabled && (transactions.data?.data.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
            <CardDescription>
              Money out is negative. Reversed and duplicate transactions never
              count as payments.
            </CardDescription>
          </CardHeader>
          <ul className="divide-y px-6 pb-4">
            {transactions.data?.data.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {format(row.madeOn)} {row.description}
                  <span className="block text-xs text-muted-foreground">
                    {row.accountName} · {TX_STATUS[row.status] ?? row.status}
                    {row.duplicated ? " · duplicate" : ""}
                    {row.counted.length
                      ? ` · counted for ${row.counted.length} invoice${row.counted.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {money(row.amount, row.currency)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog
        open={reconnecting !== null}
        onOpenChange={(open) => !open && setReconnecting(null)}
      >
        <DialogContent className="max-w-md">
          <form
            className="space-y-4 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!reconnecting) return;
              reconnect.mutate({
                connectionId: reconnecting.id,
                consentAccepted: true,
                consentPeriodDays: period as 30 | 60 | 90 | 180,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Renew consent</DialogTitle>
              <DialogDescription>
                You will sign in at {reconnecting?.bankName ?? "the bank"} again
                to renew read access.
              </DialogDescription>
            </DialogHeader>
            <ConsentFields
              periods={data.consentPeriods}
              period={period}
              onPeriod={setPeriod}
              accepted={accepted}
              onAccepted={setAccepted}
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !accepted}>
                Continue to the bank
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
      >
        <DialogContent className="max-w-md">
          <div className="space-y-4 p-4">
            <DialogHeader>
              <DialogTitle>Disconnect {disconnecting?.bankName ?? "bank"}?</DialogTitle>
              <DialogDescription>
                InvoiceWise stops reading this bank and withdraws its consent
                at Salt Edge. Transactions no invoice payment counts are
                deleted; those an invoice's payment counts are kept as its
                evidence.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDisconnecting(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  disconnecting &&
                  disconnect.mutate({ connectionId: disconnecting.id })
                }
              >
                Disconnect
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
