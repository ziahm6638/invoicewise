"use client";

import { CopyInput } from "@/components/copy-input";
import { useTeamPermissions } from "@/hooks/use-team";
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
  AlertDialogTrigger,
} from "@invoicewise/ui/alert-dialog";
import { Badge } from "@invoicewise/ui/badge";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { useState } from "react";

type ReceivedMessage = RouterOutputs["inboundEmail"]["get"]["messages"][number];

const outcomeLabel: Record<string, string> = {
  accepted: "read",
  duplicate: "already received",
  rejected: "not readable",
  skipped: "skipped",
};

function messageStatus(message: ReceivedMessage) {
  if (message.status === "received") return "Processing";
  if (message.status === "failed") return "Failed";
  const read = message.attachments.filter(
    ({ outcome }) => outcome === "accepted" || outcome === "duplicate",
  ).length;
  return read > 0
    ? `${read} invoice${read === 1 ? "" : "s"}`
    : "No invoice found";
}

function ReceivedMessageItem({ message }: { message: ReceivedMessage }) {
  const failed = message.status === "failed";
  return (
    <li className="py-3 border-t text-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate">{message.subject || "(no subject)"}</p>
          <p className="truncate text-xs text-[#878787]">
            {message.headerFrom ?? message.envelopeFrom ?? "Unknown sender"} ·{" "}
            {formatDistanceToNow(new Date(message.createdAt), {
              addSuffix: true,
            })}
          </p>
        </div>
        <Badge variant={failed ? "destructive" : "outline"}>
          {messageStatus(message)}
        </Badge>
      </div>
      {message.detail && (
        <p className="mt-1 text-xs text-[#878787] break-words">
          {message.detail}
        </p>
      )}
      {message.attachments.some(({ outcome }) => outcome !== "accepted") && (
        <ul className="mt-1 text-xs text-[#878787]">
          {message.attachments.map((attachment) => (
            <li key={attachment.index} className="truncate">
              {attachment.fileName ?? `Attachment ${attachment.index + 1}`}:{" "}
              {outcomeLabel[attachment.outcome] ?? attachment.outcome}
              {attachment.message ? ` (${attachment.message})` : ""}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function RotateAddress() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const rotate = useMutation(
    trpc.inboundEmail.rotate.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.inboundEmail.get.queryKey(),
        });
        setOpen(false);
      },
    }),
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={rotate.isPending}>
          Replace address
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace this address?</AlertDialogTitle>
          <AlertDialogDescription>
            The current address stops working immediately and mail sent to it is
            refused. Update any suppliers or forwarding rules with the new
            address.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={rotate.isPending}
            onClick={(event) => {
              event.preventDefault();
              rotate.mutate();
            }}
          >
            {rotate.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Replace"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function InboxEmailSettings() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.inboundEmail.get.queryOptions());
  const { manageIntegrations } = useTeamPermissions();

  if (!data.address) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Address</CardTitle>
        <CardDescription>
          Forward supplier invoices to this address, or give it to suppliers.
          Each PDF, JPEG or PNG attachment is read as an invoice and appears in
          your inbox. Mail to any other address is refused.
        </CardDescription>
      </CardHeader>

      <div className="px-6 pb-6 max-w-[480px]">
        <CopyInput value={data.address} />
      </div>

      {data.messages.length > 0 && (
        <div className="px-6 pb-6">
          <p className="text-sm font-medium pb-2">Recently received</p>
          <ul>
            {data.messages.map((message) => (
              <ReceivedMessageItem key={message.id} message={message} />
            ))}
          </ul>
        </div>
      )}

      {manageIntegrations && (
        <CardFooter className="flex justify-between border-t pt-6">
          <p className="text-sm text-[#606060]">
            Replace the address if it is receiving unwanted mail.
          </p>
          <RotateAddress />
        </CardFooter>
      )}
    </Card>
  );
}
