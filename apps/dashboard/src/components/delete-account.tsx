"use client";

import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/trpc/client";
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
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";

/**
 * The confirmed account-deletion dialog, opened by `children`.
 *
 * A workspace the user solely owns blocks deletion. One nobody else belongs to
 * is deleted in the same step once its name is typed back, as for workspace
 * deletion; a shared one must have its ownership transferred first. The server
 * re-checks all of this.
 */
export function DeleteAccountDialog({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>(
    {},
  );

  const { data: soleOwned, isLoading } = useQuery({
    ...trpc.user.soleOwnedWorkspaces.queryOptions(),
    enabled: open,
  });

  const shared = soleOwned?.filter((workspace) => workspace.shared) ?? [];
  const unshared = soleOwned?.filter((workspace) => !workspace.shared) ?? [];

  const deleteUserMutation = useMutation(
    trpc.user.delete.mutationOptions({
      onSuccess: async () => {
        await authClient.signOut();
        router.push("/");
      },
      onError: (error) => {
        toast({
          title: "Account was not deleted",
          description: error.message,
          variant: "destructive",
        });
      },
    }),
  );

  const confirmed =
    value === "DELETE" &&
    unshared.every(
      (workspace) =>
        workspaceNames[workspace.id]?.trim() === workspace.confirmation,
    );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setValue("");
          setWorkspaceNames({});
        }
      }}
    >
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone. You are signed out everywhere and your
            account, API keys and memberships are removed from InvoiceWise
            immediately. Backups taken before now keep a copy until they expire,
            about two weeks later.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : shared.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            You are the only owner of a workspace other members still use:{" "}
            <span className="font-medium text-foreground">
              {shared.map((workspace) => workspace.confirmation).join(", ")}
            </span>
            . Make another member an owner, or delete the workspace, before
            deleting your account.
          </p>
        ) : (
          <div className="flex flex-col gap-4 mt-2">
            {unshared.map((workspace) => (
              <div key={workspace.id} className="flex flex-col gap-2">
                <Label htmlFor={`confirm-workspace-${workspace.id}`}>
                  Your workspace{" "}
                  <span className="font-medium">{workspace.confirmation}</span>{" "}
                  is deleted too: its invoices, documents, questions, mailbox
                  and accounting connections, API keys and settings. Type{" "}
                  <span className="font-medium">{workspace.confirmation}</span>{" "}
                  to confirm.
                </Label>
                <Input
                  id={`confirm-workspace-${workspace.id}`}
                  autoComplete="off"
                  value={workspaceNames[workspace.id] ?? ""}
                  onChange={(e) =>
                    setWorkspaceNames((names) => ({
                      ...names,
                      [workspace.id]: e.target.value,
                    }))
                  }
                />
              </div>
            ))}

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-delete">
                Type <span className="font-medium">DELETE</span> to confirm.
              </Label>
              <Input
                id="confirm-delete"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Stay open while the request runs so an error is visible here.
              event.preventDefault();
              deleteUserMutation.mutate({
                deleteWorkspaces: unshared.map((workspace) => ({
                  teamId: workspace.id,
                  confirmName: workspaceNames[workspace.id] ?? "",
                })),
              });
            }}
            disabled={
              isLoading ||
              shared.length > 0 ||
              !confirmed ||
              deleteUserMutation.isPending
            }
          >
            {deleteUserMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Continue"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteAccount() {
  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Delete your sign-in, profile and memberships. Workspaces you share
          with others, and their invoices, stay with the remaining members; if
          you are the only owner of one, transfer ownership first. A workspace
          only you belong to is deleted with your account.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex justify-between">
        <div />

        <DeleteAccountDialog>
          <Button
            variant="destructive"
            className="hover:bg-destructive text-muted"
          >
            Delete
          </Button>
        </DeleteAccountDialog>
      </CardFooter>
    </Card>
  );
}
