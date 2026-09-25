"use client";

import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { formatDate } from "@/utils/format";
import { Button } from "@invoicewise/ui/button";
import { Checkbox } from "@invoicewise/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { Skeleton } from "@invoicewise/ui/skeleton";
import { Textarea } from "@invoicewise/ui/textarea";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type PaymentDecision,
  PaymentMatchView,
  type PaymentSummary,
} from "./payment-match-view";

const money = (amount: string, currency: string | null) => {
  const value = Number(amount);
  if (!currency || !Number.isFinite(value))
    return `${amount} ${currency ?? ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
};

type Chosen = Record<string, { amount: string; fee: string }>;

/**
 * The invoice's bank payment (optional feature). Every member sees whether
 * it is paid; owners and admins see the transactions and evidence, confirm a
 * proposal, choose the transactions that paid it (with any bank charge) or
 * record that none did.
 */
export function PaymentMatch({ inboxId }: { inboxId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useUserQuery();
  const [choosing, setChoosing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [chosen, setChosen] = useState<Chosen>({});
  const [reason, setReason] = useState("");

  const { data, isLoading } = useQuery(
    trpc.bankPayments.forInvoice.queryOptions({ inboxId }),
  );

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.bankPayments.forInvoice.queryKey({ inboxId }),
    });
  const done = (title: string) => () => {
    toast({ duration: 3500, variant: "success", title });
    setChoosing(false);
    setUnlinking(false);
    setChosen({});
    setReason("");
    return refresh();
  };
  const fail = (title: string) => (error: { message: string }) =>
    toast({
      duration: 6000,
      variant: "error",
      title,
      description: error.message,
    });

  const confirm = useMutation(
    trpc.bankPayments.confirm.mutationOptions({
      onSuccess: done("Payment confirmed"),
      onError: fail("The payment could not be confirmed"),
    }),
  );
  const record = useMutation(
    trpc.bankPayments.record.mutationOptions({
      onSuccess: done("Payment recorded"),
      onError: fail("The payment could not be recorded"),
    }),
  );
  const unlink = useMutation(
    trpc.bankPayments.unlink.mutationOptions({
      onSuccess: done("Recorded as not paid by these transactions"),
      onError: fail("The decision could not be saved"),
    }),
  );
  const busy = confirm.isPending || record.isPending || unlink.isPending;

  if (isLoading) return <Skeleton className="mb-7 h-16 w-full" />;
  // A workspace that does not use bank payments sees no Payment section.
  if (!data || (!data.enabled && !data.current)) return null;

  const format = (value: string) => formatDate(value, user?.dateFormat);
  const current = data.canDecide
    ? (data.current as unknown as PaymentDecision | null)
    : null;
  const summary = data.canDecide
    ? null
    : (data.current as unknown as PaymentSummary | null);
  const expectedMatchId = (data.current as { id?: string } | null)?.id ?? null;

  const actions = data.canDecide && data.enabled && data.processed && (
    <div className="flex flex-wrap gap-2 border-t py-3">
      {current?.status === "proposed" && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => confirm.mutate({ inboxId, expectedMatchId })}
        >
          Confirm payment
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setChosen({});
          setReason("");
          setChoosing(true);
        }}
      >
        Choose transactions
      </Button>
      {current?.allocations.some((item) => item.kind !== "credit") && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setReason("");
            setUnlinking(true);
          }}
        >
          Not paid by these
        </Button>
      )}
    </div>
  );

  const payments = Object.entries(chosen).map(([transactionId, value]) => ({
    transactionId,
    amount: value.amount.trim() || "0",
    fee: value.fee.trim() || null,
  }));

  return (
    <section className="mb-7">
      <h3 className="text-sm font-semibold">Payment</h3>
      <PaymentMatchView
        enabled={data.enabled}
        processed={data.processed}
        current={current}
        summary={summary}
        history={data.history as unknown as PaymentDecision[]}
        formatDate={format}
        formatAmount={money}
        actions={actions || undefined}
      />

      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent className="max-w-xl">
          <form
            className="p-4"
            onSubmit={(event) => {
              event.preventDefault();
              record.mutate({
                inboxId,
                expectedMatchId,
                reason: reason.trim() || null,
                payments,
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Which transactions paid this invoice?</DialogTitle>
              <DialogDescription>
                Only posted transactions in the invoice's own currency are
                listed; amounts are never converted. Give how much of each paid
                this invoice, and any part that was a bank charge.
              </DialogDescription>
            </DialogHeader>
            <ul className="mt-4 max-h-72 divide-y overflow-y-auto rounded border">
              {data.choices.map((choice) => {
                const selected = chosen[choice.id];
                return (
                  <li key={choice.id} className="space-y-1 p-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`tx-${choice.id}`}
                        checked={Boolean(selected)}
                        onCheckedChange={(checked) =>
                          setChosen((all) => {
                            const next = { ...all };
                            if (checked) {
                              next[choice.id] = {
                                amount: choice.available,
                                fee: "",
                              };
                            } else delete next[choice.id];
                            return next;
                          })
                        }
                      />
                      <Label
                        htmlFor={`tx-${choice.id}`}
                        className="min-w-0 flex-1 text-sm font-normal"
                      >
                        {format(choice.madeOn)} {choice.description}
                        <span className="block text-xs text-muted-foreground">
                          {money(choice.amount, choice.currency)} ·{" "}
                          {money(choice.available, choice.currency)} left ·{" "}
                          {choice.accountName}
                        </span>
                      </Label>
                    </div>
                    {selected && (
                      <div className="flex gap-2 pl-6">
                        <Input
                          aria-label="Paid to this invoice"
                          value={selected.amount}
                          inputMode="decimal"
                          onChange={(event) =>
                            setChosen((all) => ({
                              ...all,
                              [choice.id]: {
                                ...selected,
                                amount: event.target.value,
                              },
                            }))
                          }
                        />
                        <Input
                          aria-label="Bank charge"
                          placeholder="Bank charge"
                          value={selected.fee}
                          inputMode="decimal"
                          onChange={(event) =>
                            setChosen((all) => ({
                              ...all,
                              [choice.id]: {
                                ...selected,
                                fee: event.target.value,
                              },
                            }))
                          }
                        />
                      </div>
                    )}
                  </li>
                );
              })}
              {data.choices.length === 0 && (
                <li className="p-2 text-sm text-muted-foreground">
                  No posted transactions in this currency and date window.
                </li>
              )}
            </ul>
            <div className="mt-4 space-y-2">
              <Label htmlFor="payment-reason">Reason</Label>
              <Textarea
                id="payment-reason"
                placeholder="Required when replacing a matched payment or paying more than the total"
                value={reason}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={busy || payments.length === 0}>
                Save payment
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={unlinking} onOpenChange={setUnlinking}>
        <DialogContent className="max-w-md">
          <form
            className="p-4"
            onSubmit={(event) => {
              event.preventDefault();
              unlink.mutate({
                inboxId,
                expectedMatchId,
                reason: reason.trim(),
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Not paid by these transactions</DialogTitle>
              <DialogDescription>
                Records that none of the bank transactions paid this invoice.
                Automatic matching keeps this decision.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-2">
              <Label htmlFor="payment-unlink-reason">Reason</Label>
              <Textarea
                id="payment-unlink-reason"
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={busy || reason.trim() === ""}>
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
