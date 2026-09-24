"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useUserQuery } from "@/hooks/use-user";
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
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteTeam() {
  const [value, setValue] = useState("");
  const trpc = useTRPC();
  const { data: user } = useUserQuery();
  const permissions = useTeamPermissions();
  const router = useRouter();

  const deleteTeamMutation = useMutation(
    trpc.team.delete.mutationOptions({
      onSuccess: async () => {
        // Revalidate server state and redirect
        router.push("/teams");
      },
    }),
  );

  // Only the workspace owner can delete it; the server enforces this too.
  if (!permissions.deleteWorkspace) {
    return null;
  }

  return (
    <Card className="border-destructive">
      <CardHeader>
        <CardTitle>Delete team</CardTitle>
        <CardDescription>
          Permanently remove your Team and all of its contents from the
          InvoiceWise platform. This action is not reversible — please continue
          with caution.
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
              <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete your
                team and remove your data from our servers.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex flex-col gap-2 mt-2">
              <Label htmlFor="confirm-delete">
                Type <span className="font-medium">DELETE</span> to confirm.
              </Label>
              <Input
                id="confirm-delete"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  deleteTeamMutation.mutate({ teamId: user?.teamId! })
                }
                disabled={value !== "DELETE"}
              >
                {deleteTeamMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Confirm"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>
  );
}
