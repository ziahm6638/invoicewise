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

type Provider =
  RouterOutputs["accounting"]["get"]["providers"][number]["provider"];

const PROVIDERS: { provider: Provider; name: string; outcome: string }[] = [
  {
    provider: "xero",
    name: "Xero",
    outcome: "Invoices arrive in Xero as draft bills awaiting your approval.",
  },
  {
    provider: "quickbooks",
    name: "QuickBooks Online",
    outcome:
      "QuickBooks has no draft bills: invoices arrive as unpaid, open bills.",
  },
];

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

  const busy =
    connect.isPending || completeConnection.isPending || disconnect.isPending;

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

          return (
            <div
              key={provider}
              className="flex items-center justify-between gap-4 py-4"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{name}</span>
                  {connection ? (
                    <Badge variant="tag-rounded" className="text-xs">
                      Connected
                    </Badge>
                  ) : null}
                </div>
                <span className="text-muted-foreground text-xs">
                  {connection
                    ? `Connected ${formatDistanceToNow(new Date(connection.connectedAt))} ago. ${outcome}`
                    : available
                      ? outcome
                      : `${name} is not available yet.`}
                </span>
              </div>

              {connection ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  disabled={busy}
                  onClick={() => disconnect.mutate({ provider })}
                >
                  Disconnect
                </Button>
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
          );
        })}
      </div>
    </Card>
  );
}
