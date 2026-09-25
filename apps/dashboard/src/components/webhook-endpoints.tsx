"use client";

import { CopyInput } from "@/components/copy-input";
import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@invoicewise/ui/alert-dialog";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Checkbox } from "@invoicewise/ui/checkbox";
import { cn } from "@invoicewise/ui/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@invoicewise/ui/sheet";
import { useToast } from "@invoicewise/ui/use-toast";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";

type Endpoint = RouterOutputs["webhooks"]["list"]["endpoints"][number];
type Delivery = RouterOutputs["webhooks"]["deliveries"][number];

const EVENT_LABELS: Record<string, string> = {
  "invoice.processed": "Invoice processed",
  "invoice.judgments.attached": "Judgments attached",
  "invoice.matched": "Matched to authorization sources",
  "invoice.reconciled": "Reconciled with authorization sources",
  "delivery.failed": "Delivery failed",
  "webhook.test": "Test event",
};

const STATUS_LABELS: Record<Delivery["status"], string> = {
  queued: "Queued",
  delivering: "Retrying",
  succeeded: "Delivered",
  failed: "Failed",
  cancelled: "Cancelled",
};

const statusTone = (status: Delivery["status"]) =>
  status === "failed"
    ? "text-destructive"
    : status === "cancelled"
      ? "text-muted-foreground"
      : status === "succeeded"
        ? "text-emerald-700 dark:text-emerald-300"
        : "text-sky-700 dark:text-sky-300";

type Secret = { title: string; description: string; secret: string };

export function WebhookEndpoints() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useSuspenseQuery(trpc.webhooks.list.queryOptions());

  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [rotating, setRotating] = useState<Endpoint | null>(null);
  const [disabling, setDisabling] = useState<Endpoint | null>(null);
  const [inspecting, setInspecting] = useState<Endpoint | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
  const fail = (title: string) => (error: { message: string }) =>
    toast({
      duration: 5000,
      variant: "error",
      title,
      description: error.message,
    });

  const sendTest = useMutation(
    trpc.webhooks.sendTest.mutationOptions({
      onSuccess: (_, { id }) => {
        toast({
          duration: 3500,
          variant: "success",
          title: "Test event queued",
          description: "Its outcome appears under Deliveries.",
        });
        queryClient.invalidateQueries({
          queryKey: trpc.webhooks.deliveries.queryKey({ id }),
        });
      },
      onError: fail("Unable to send a test event"),
    }),
  );

  const disable = useMutation(
    trpc.webhooks.disable.mutationOptions({
      onSuccess: () => {
        setDisabling(null);
        refresh();
      },
      onError: fail("Unable to disable the endpoint"),
    }),
  );

  const active = data.endpoints.filter((endpoint) => endpoint.active);
  const disabled = data.endpoints.filter((endpoint) => !endpoint.active);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>
              InvoiceWise sends signed events to your HTTPS endpoints when
              invoices are processed. Each event may arrive more than once:
              deduplicate on its event ID.
            </CardDescription>
          </div>
          <Button size="sm" className="text-xs" onClick={() => setAdding(true)}>
            Add endpoint
          </Button>
        </CardHeader>

        <div className="px-6 pb-2 divide-y">
          {data.endpoints.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No endpoints yet. Add one to receive invoice events.
            </p>
          ) : null}

          {[...active, ...disabled].map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-mono text-sm">
                    {endpoint.url}
                  </span>
                  {!endpoint.active ? (
                    <Badge variant="tag-rounded" className="text-xs">
                      Disabled
                    </Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {endpoint.events.map((event) => (
                    <Badge key={event} variant="tag" className="text-xs">
                      {EVENT_LABELS[event] ?? event}
                    </Badge>
                  ))}
                </div>
                <span className="text-muted-foreground text-xs">
                  Added {formatDistanceToNow(new Date(endpoint.createdAt))} ago
                  {endpoint.secretRotatedAt
                    ? ` · secret rotated ${formatDistanceToNow(new Date(endpoint.secretRotatedAt))} ago`
                    : ""}
                  {endpoint.previousSecretExpiresAt
                    ? ` · previous secret also signs until ${format(new Date(endpoint.previousSecretExpiresAt), "d MMM HH:mm")}`
                    : ""}
                </span>
              </div>

              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  onClick={() => setInspecting(endpoint)}
                >
                  Deliveries
                </Button>
                {endpoint.active ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={sendTest.isPending}
                      onClick={() => sendTest.mutate({ id: endpoint.id })}
                    >
                      Send test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => setRotating(endpoint)}
                    >
                      Rotate secret
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      onClick={() => setDisabling(endpoint)}
                    >
                      Disable
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <AddEndpointDialog
        open={adding}
        events={data.events}
        onOpenChange={setAdding}
        onCreated={(created) => {
          setAdding(false);
          refresh();
          setSecret({
            title: "Endpoint added",
            description:
              "This signing secret is shown once. Store it where your endpoint verifies the invoicewise-signature header.",
            secret: created.secret,
          });
        }}
      />

      <RotateSecretDialog
        endpoint={rotating}
        overlapHours={data.secretOverlapHours}
        onOpenChange={() => setRotating(null)}
        onRotated={(rotated, revoked) => {
          setRotating(null);
          refresh();
          setSecret({
            title: "Secret rotated",
            description: revoked
              ? "The previous secret no longer signs deliveries. This new secret is shown once."
              : `Deliveries are signed with both the new and the previous secret for ${data.secretOverlapHours} hours, so you can deploy the new one without dropping events. This new secret is shown once.`,
            secret: rotated.secret,
          });
        }}
      />

      <Dialog open={secret !== null} onOpenChange={() => setSecret(null)}>
        <DialogContent className="max-w-[455px]">
          <div className="p-4 space-y-4">
            <DialogHeader>
              <DialogTitle>{secret?.title}</DialogTitle>
              <DialogDescription>{secret?.description}</DialogDescription>
            </DialogHeader>
            {secret ? <CopyInput value={secret.secret} /> : null}
            <DialogFooter>
              <Button className="w-full" onClick={() => setSecret(null)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={disabling !== null}
        onOpenChange={() => setDisabling(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              {disabling?.url} stops receiving events, and deliveries still
              queued for it are cancelled. Adding the same URL again enables it
              with a new secret.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disable.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (disabling) disable.mutate({ id: disabling.id });
              }}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeliveriesSheet
        endpoint={inspecting}
        onOpenChange={() => setInspecting(null)}
      />
    </>
  );
}

function AddEndpointDialog({
  open,
  events,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  events: readonly string[];
  onOpenChange: (open: boolean) => void;
  onCreated: (created: RouterOutputs["webhooks"]["create"]) => void;
}) {
  const trpc = useTRPC();
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([...events]);
  const create = useMutation(
    trpc.webhooks.create.mutationOptions({
      onSuccess: (created) => {
        setUrl("");
        setSelected([...events]);
        onCreated(created);
      },
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[455px]">
        <form
          className="p-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({
              url: url.trim(),
              events:
                selected as RouterOutputs["webhooks"]["list"]["events"][number][],
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Add webhook endpoint</DialogTitle>
            <DialogDescription>
              A public HTTPS URL. Addresses that resolve to private, loopback or
              link-local networks are refused.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="webhook-url">Endpoint URL</Label>
            <Input
              id="webhook-url"
              type="url"
              required
              autoComplete="off"
              placeholder="https://example.com/invoicewise"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            {events.map((event) => (
              <div key={event} className="flex items-center gap-2">
                <Checkbox
                  id={`webhook-event-${event}`}
                  checked={selected.includes(event)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked
                        ? [...current, event]
                        : current.filter((value) => value !== event),
                    )
                  }
                />
                <Label
                  htmlFor={`webhook-event-${event}`}
                  className="text-sm font-normal"
                >
                  {EVENT_LABELS[event] ?? event}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    {event}
                  </span>
                </Label>
              </div>
            ))}
          </fieldset>

          {create.error ? (
            <p className="text-sm text-destructive">{create.error.message}</p>
          ) : null}

          <DialogFooter>
            <Button
              type="submit"
              className="w-full"
              disabled={create.isPending || selected.length === 0 || !url}
            >
              Add endpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateSecretDialog({
  endpoint,
  overlapHours,
  onOpenChange,
  onRotated,
}: {
  endpoint: Endpoint | null;
  overlapHours: number;
  onOpenChange: () => void;
  onRotated: (
    rotated: RouterOutputs["webhooks"]["rotateSecret"],
    revoked: boolean,
  ) => void;
}) {
  const trpc = useTRPC();
  const { toast } = useToast();
  const [revokePrevious, setRevokePrevious] = useState(false);
  const rotate = useMutation(
    trpc.webhooks.rotateSecret.mutationOptions({
      onSuccess: (rotated, input) => {
        setRevokePrevious(false);
        onRotated(rotated, Boolean(input.revokePrevious));
      },
      onError: (error) =>
        toast({
          duration: 5000,
          variant: "error",
          title: "Unable to rotate the secret",
          description: error.message,
        }),
    }),
  );

  return (
    <AlertDialog open={endpoint !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Rotate signing secret?</AlertDialogTitle>
          <AlertDialogDescription>
            A new secret is generated and shown once. For {overlapHours} hours
            each delivery carries a signature for the new and the previous
            secret, so either verifies it while you deploy the change.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id="webhook-revoke-previous"
            checked={revokePrevious}
            onCheckedChange={(checked) => setRevokePrevious(checked === true)}
          />
          <Label
            htmlFor="webhook-revoke-previous"
            className="text-sm font-normal"
          >
            Stop signing with the previous secret now (it leaked)
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={rotate.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (endpoint) rotate.mutate({ id: endpoint.id, revokePrevious });
            }}
          >
            Rotate secret
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeliveriesSheet({
  endpoint,
  onOpenChange,
}: {
  endpoint: Endpoint | null;
  onOpenChange: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const deliveries = useQuery({
    ...trpc.webhooks.deliveries.queryOptions({ id: endpoint?.id ?? "" }),
    enabled: endpoint !== null,
    // In-flight deliveries settle on their own; keep the list current.
    refetchInterval: (query) =>
      query.state.data?.some(
        ({ status }) => status === "queued" || status === "delivering",
      )
        ? 3000
        : false,
  });
  const redeliver = useMutation(
    trpc.webhooks.redeliver.mutationOptions({
      onSuccess: () => {
        toast({
          duration: 3500,
          variant: "success",
          title: "Redelivery queued",
          description: "The same event ID is sent again.",
        });
        queryClient.invalidateQueries({
          queryKey: trpc.webhooks.deliveries.queryKey({ id: endpoint!.id }),
        });
      },
      onError: (error) =>
        toast({
          duration: 5000,
          variant: "error",
          title: "Unable to redeliver",
          description: error.message,
        }),
    }),
  );

  return (
    <Sheet open={endpoint !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[560px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Deliveries</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs">
            {endpoint?.url}
          </SheetDescription>
        </SheetHeader>

        <p className="mt-4 text-xs text-muted-foreground">
          Each delivery is retried up to four times with backoff. Redelivering a
          failed event sends the same event ID again, so a consumer that already
          handled it can ignore it.
        </p>

        <ul className="mt-4 divide-y">
          {deliveries.data?.length === 0 ? (
            <li className="py-6 text-sm text-muted-foreground">
              No deliveries yet. Send a test event to try the endpoint.
            </li>
          ) : null}
          {deliveries.data?.map((delivery) => (
            <li key={delivery.id} className="py-3">
              <div className="flex items-start justify-between gap-4">
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() =>
                    setExpanded(expanded === delivery.id ? null : delivery.id)
                  }
                >
                  <p className="truncate text-sm font-medium">
                    {EVENT_LABELS[delivery.event] ?? delivery.event}
                    {delivery.revision !== null
                      ? ` · revision ${delivery.revision}`
                      : ""}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {delivery.eventId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(delivery.createdAt))} ago ·{" "}
                    {delivery.attempts}{" "}
                    {delivery.attempts === 1 ? "attempt" : "attempts"}
                  </p>
                  {delivery.lastError &&
                  (delivery.status === "failed" ||
                    delivery.status === "cancelled") ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {delivery.lastError}
                    </p>
                  ) : null}
                </button>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span
                    className={cn(
                      "text-xs font-medium",
                      statusTone(delivery.status),
                    )}
                  >
                    {STATUS_LABELS[delivery.status]}
                  </span>
                  {delivery.status === "failed" && endpoint?.active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={redeliver.isPending}
                      onClick={() =>
                        redeliver.mutate({
                          id: endpoint.id,
                          deliveryId: delivery.id,
                        })
                      }
                    >
                      Redeliver
                    </Button>
                  ) : null}
                </div>
              </div>
              {expanded === delivery.id && endpoint ? (
                <DeliveryAttempts
                  endpointId={endpoint.id}
                  deliveryId={delivery.id}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

function DeliveryAttempts({
  endpointId,
  deliveryId,
}: {
  endpointId: string;
  deliveryId: string;
}) {
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.webhooks.attempts.queryOptions({ id: endpointId, deliveryId }),
  );
  if (!data) return null;
  return (
    <ol className="mt-2 space-y-1 border-l pl-3">
      {data.length === 0 ? (
        <li className="text-xs text-muted-foreground">No attempts yet.</li>
      ) : null}
      {data.map((attempt) => (
        <li key={attempt.id} className="text-xs text-muted-foreground">
          #{attempt.attempt} ·{" "}
          {format(new Date(attempt.createdAt), "d MMM HH:mm:ss")} ·{" "}
          {attempt.statusCode ? `HTTP ${attempt.statusCode}` : "no response"} ·{" "}
          {attempt.durationMs} ms
          {attempt.error ? ` · ${attempt.error}` : ""}
        </li>
      ))}
    </ol>
  );
}
