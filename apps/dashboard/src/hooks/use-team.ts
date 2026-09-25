"use client";

import { useTRPC } from "@/trpc/client";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

export function useTeamQuery() {
  const trpc = useTRPC();
  return useSuspenseQuery(trpc.team.current.queryOptions());
}

/**
 * Server-decided capabilities for the current workspace. UI gating only; the
 * server re-checks every mutation.
 */
export function useTeamPermissions() {
  const { data } = useTeamQuery();

  return (
    data?.permissions ?? {
      manageMembers: false,
      manageQuestions: false,
      manageIntegrations: false,
      manageWorkspaceSettings: false,
      postToAccounting: false,
      manageBilling: false,
      deleteWorkspace: false,
      transferOwnership: false,
      exportData: false,
    }
  );
}

export function useTeamMutation() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.team.update.mutationOptions({
      onMutate: async (newData) => {
        // Cancel outgoing refetches
        await queryClient.cancelQueries({
          queryKey: trpc.team.current.queryKey(),
        });

        // Get current data
        const previousData = queryClient.getQueryData(
          trpc.team.current.queryKey(),
        );

        // Optimistically update
        queryClient.setQueryData(trpc.team.current.queryKey(), (old: any) => ({
          ...old,
          ...newData,
        }));

        return { previousData };
      },
      onError: (_, __, context) => {
        // Rollback on error
        queryClient.setQueryData(
          trpc.team.current.queryKey(),
          context?.previousData,
        );
      },
      onSettled: () => {
        // Refetch after error or success
        queryClient.invalidateQueries({
          queryKey: trpc.team.current.queryKey(),
        });
      },
    }),
  );
}
