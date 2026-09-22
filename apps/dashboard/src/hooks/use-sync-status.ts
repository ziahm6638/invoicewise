import { useTRPC } from "@/trpc/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

type SyncStatus = "FAILED" | "SYNCING" | "COMPLETED" | null;

export function useSyncStatus({ runId }: { runId?: string }) {
  const trpc = useTRPC();
  const [forcedStatus, setStatus] = useState<SyncStatus>(null);
  const { data, error } = useQuery(
    trpc.inboxAccounts.syncStatus.queryOptions(
      { id: runId ?? "00000000-0000-0000-0000-000000000000" },
      {
        enabled: !!runId,
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          return status === "succeeded" || status === "failed" ? false : 1000;
        },
      },
    ),
  );

  useEffect(() => setStatus(runId ? "SYNCING" : null), [runId]);

  const status: SyncStatus = error
    ? "FAILED"
    : data?.status === "failed"
      ? "FAILED"
      : data?.status === "succeeded"
        ? "COMPLETED"
        : forcedStatus;

  return {
    status,
    setStatus,
    result: data?.result as
      | { attachmentsProcessed?: number }
      | null
      | undefined,
  };
}
