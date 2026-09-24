"use client";

import { useTeamPermissions, useTeamQuery } from "@/hooks/use-team";
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
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * What the owner types to confirm. Mirrors `workspaceDeletionConfirmation` in
 * `@invoicewise/db`; the server re-checks it.
 */
const confirmationFor = (name: string | null | undefined) =>
  name?.trim() || "DELETE";

export function DeleteTeam() {
  const [value, setValue] = useState("");
  const trpc = useTRPC();
  const { data: team } = useTeamQuery();
  const permissions = useTeamPermissions();
  const router = useRouter();
  const { toast } = useToast();
  const confirmation = confirmationFor(team?.name);

  const deleteTeamMutation = useMutation(
    trpc.team.delete.mutationOptions({
      onSuccess: async () => {
        router.push("/teams");
      },
      onError: (error) => {
        toast({
          title: "Workspace was not deleted",
          description: error.message,
          variant: "destructive",
        });
      },
    }),
  );

  // Only the workspace owner can delete it; the server enforces this too.
  if (!permissions.deleteWorkspace || !team) {
    return null;
  }

  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle>Delete workspace</CardTitle>
        <CardDescription>
          Delete this workspace for every member: its invoices, documents,
          questions, mailbox and accounting connections, API keys and settings.
          Members keep their own accounts. To leave the workspace running
          without you, transfer ownership to another member instead.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex justify-between">
        <div />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              className="hover:bg-destructive text-muted"
            >
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {confirmation}?</AlertDialogTitle>
              <AlertDialogDescription>
                This cannot be undone. Access for every member, API key and
                connection ends immediately, and the workspace's data is removed
                from InvoiceWise; stored files and provider connections follow
                shortly after. Backups taken before now keep a copy until they
                expire, about two weeks later.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-2 mt-2">
              <Label htmlFor="confirm-delete">
                Type <span className="font-medium">{confirmation}</span> to
                confirm.
              </Label>
              <Input
                id="confirm-delete"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  deleteTeamMutation.mutate({
                    teamId: team.id,
                    confirmName: value,
                  })
                }
                disabled={
                  value.trim() !== confirmation || deleteTeamMutation.isPending
                }
              >
                {deleteTeamMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Delete workspace"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
