"use client";

import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@api/trpc/routers/_app";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { useToast } from "@invoicewise/ui/use-toast";
import Nango from "@nangohq/frontend";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AccountingSetup } from "./accounting-setup";

type Provider =
  RouterOutputs["accounting"]["get"]["providers"][number]["provider"];

const PROVIDERS: { provider: Provider; name: string; outcome: string }[] = [
  {
    provider: "xero",
    name: "Xero",
    outcome:
      "Invoices arrive in Xero as draft bills (credit notes as draft credit notes) awaiting your approval, after you choose the organisation's account and switch on automatic bills below.",
  },
  {
    provider: "quickbooks",
    name: "QuickBooks Online",
    outcome:
      "QuickBooks has no draft bills: invoices arrive as open, unpaid bills (credit notes as vendor credits), only after you switch on automatic bills below.",
  },
];

const HEALTH: Record<string, { label: string; tone: string }> = {
  ok: { label: "Healthy", tone: "text-muted-foreground" },
  reconnect: { label: "Reconnect needed", tone: "text-destructive" },
  unavailable: { label: "Unreachable", tone: "text-destructive" },
};

export function AccountingConnections() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useSuspenseQuery(trpc.accounting.get.queryOptions());

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.accounting.get.queryKey() });
  const fail = (title: string) => (error: { message: string }) =>
    toast({
      duration: 5000,
      variant: "error",
      title,
      description: error.message,
    });

  const completeConnection = useMutation(
    trpc.accounting.completeConnection.mutationOptions({
      onSuccess: () => {
        toast({ duration: 3500, variant: "success", title: "Connected" });
        refresh();
      },
      onError: fail("The connection could not be saved"),
    }),
  );

  const connect = useMutation(
    trpc.accounting.createConnectSession.mutationOptions({
      onSuccess: (session, { provider }) => {
        // Self-hosted Nango: Connect UI and its API are InvoiceWise's own
        // hosts, returned with the session rather than Nango Cloud defaults.
        const nango = new Nango({
          connectSessionToken: session.token,
          host: session.apiUrl,
        });
        nango.openConnectUI({
          baseURL: session.connectUrl,
          apiURL: session.apiUrl,
          onEvent: (event) => {
            if (event.type === "connect") {
              completeConnection.mutate({
                provider,
                connectionId: event.payload.connectionId,
              });
            }
          },
        });
      },
      onError: fail("Unable to start the connection"),
    }),
  );

  const disconnect = useMutation(
    trpc.accounting.disconnect.mutationOptions({
      onSuccess: refresh,
      onError: fail("Unable to disconnect"),
    }),
  );

  const checkHealth = useMutation(
    trpc.accounting.checkHealth.mutationOptions({
      onSuccess: (result) => {
        toast({
          duration: 5000,
          variant: result.healthStatus === "ok" ? "success" : "error",
          title:
            result.healthStatus === "ok"
              ? "The connection is working"
              : "The connection needs attention",
          description: result.healthError ?? undefined,
        });
        refresh();
      },
      onError: fail("Unable to check the connection"),
    }),
  );

  const busy =
    connect.isPending ||
    completeConnection.isPending ||
    disconnect.isPending ||
    checkHealth.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounting</CardTitle>
        <CardDescription>
          Connect one accounting system to receive processed invoices. You
          authorise it with the provider; InvoiceWise never sees your provider
          password or tokens.
        </CardDescription>
      </CardHeader>

      <div className="px-6 pb-2 divide-y">
        {PROVIDERS.map(({ provider, name, outcome }) => {
          const available = data.providers.find(
            (entry) => entry.provider === provider,
          )?.available;
          const connection = data.connections.find(
            (entry) =>
              entry.provider === provider && entry.status === "connected",
          );
          const otherConnected = data.connections.some(
            (entry) =>
              entry.provider !== provider && entry.status === "connected",
          );

          const health = connection?.health.status
            ? HEALTH[connection.health.status]
            : undefined;
          const sandbox = connection
            ? connection.sandbox
            : data.providers.find((entry) => entry.provider === provider)
                ?.sandbox;

          return (
            <div key={provider} className="py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{name}</span>
                    {connection ? (
                      <Badge variant="tag-rounded" className="text-xs">
                        Connected
                      </Badge>
                    ) : null}
                    {available && sandbox ? (
                      <Badge variant="tag-rounded" className="text-xs">
                        Sandbox companies only
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {connection
                      ? `Connected ${formatDistanceToNow(new Date(connection.connectedAt))} ago. ${outcome}`
                      : available
                        ? outcome
                        : `${name} is not set up for InvoiceWise yet.`}
                  </span>
                  {connection ? (
                    <span className="text-xs">
                      Company:{" "}
                      <span className="font-medium">
                        {connection.organisationName ?? "unnamed"}
                      </span>
                      {connection.organisationId
                        ? ` (ID ${connection.organisationId})`
                        : ""}
                      {health ? (
                        <span className={health.tone}>
                          {" · "}
                          {health.label}
                          {connection.health.checkedAt
                            ? `, checked ${formatDistanceToNow(new Date(connection.health.checkedAt))} ago`
                            : ""}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  {connection?.health.error &&
                  connection.health.status !== "ok" ? (
                    <span className="text-xs text-destructive">
                      {connection.health.error}
                    </span>
                  ) : null}
                </div>

                {connection ? (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={busy}
                      onClick={() => checkHealth.mutate()}
                    >
                      Check
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={busy || !available}
                      onClick={() => connect.mutate({ provider })}
                    >
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs"
                      disabled={busy}
                      onClick={() => disconnect.mutate({ provider })}
                    >
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    className="text-xs"
                    disabled={busy || !available || otherConnected}
                    onClick={() => connect.mutate({ provider })}
                  >
                    Connect
                  </Button>
                )}
              </div>
              {connection ? <AccountingSetup provider={provider} /> : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
