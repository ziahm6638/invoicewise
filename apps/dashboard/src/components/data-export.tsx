"use client";

import { useTeamPermissions } from "@/hooks/use-team";
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
import { Progress } from "@invoicewise/ui/progress";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";

type DataExport = RouterOutputs["data"]["exports"][number];

const STATUS_LABEL: Record<DataExport["status"], string> = {
  queued: "Queued",
  running: "Preparing",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

const formatBytes = (bytes: number | null) => {
  if (!bytes) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

function ExportRow({
  item,
  onDownload,
  downloading,
}: {
  item: DataExport;
  onDownload: (id: string) => void;
  downloading: boolean;
}) {
  const expired =
    item.status === "expired" ||
    (item.status === "ready" &&
      !!item.expiresAt &&
      Date.parse(item.expiresAt) <= Date.now());
  const status = expired ? "expired" : item.status;
  const progress = item.progress;
  const percent =
    progress.documentsTotal > 0
      ? Math.round((progress.documentsWritten / progress.documentsTotal) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-2 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              Requested {format(new Date(item.createdAt), "d MMM yyyy, HH:mm")}
            </span>
            <Badge variant="tag-rounded" className="text-xs">
              {STATUS_LABEL[status]}
            </Badge>
          </div>
          <span className="text-muted-foreground text-xs">
            {status === "queued" && "Waiting to start."}
            {status === "running" &&
              (progress.documentsTotal > 0
                ? `${progress.documentsWritten} of ${progress.documentsTotal} documents added.`
                : "Collecting invoices and documents.")}
            {status === "ready" &&
              item.expiresAt &&
              `${item.summary?.invoices ?? 0} invoices, ${
                item.summary?.documents ?? 0
              } documents${
                item.summary?.missingDocuments
                  ? ` (${item.summary.missingDocuments} missing from storage, listed in the manifest)`
                  : ""
              }${formatBytes(item.size) ? `, ${formatBytes(item.size)}` : ""}. Available for ${formatDistanceToNow(
                new Date(item.expiresAt),
              )}.`}
            {status === "expired" &&
              "The download expired and the archive was removed. Request a new export."}
            {status === "failed" &&
              (item.error ?? "The export could not be prepared.")}
          </span>
        </div>

        {status === "ready" ? (
          <Button
            size="sm"
            className="text-xs"
            disabled={downloading}
            onClick={() => onDownload(item.id)}
          >
            Download
          </Button>
        ) : null}
      </div>

      {status === "running" && progress.documentsTotal > 0 ? (
        <Progress value={percent} className="h-1" />
      ) : null}
    </div>
  );
}

/**
 * Owner-only workspace export: a ZIP of every original document plus
 * portable invoice, judgment, supplier and audit records and a manifest.
 */
export function DataExport() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const permissions = useTeamPermissions();
  const retention = useQuery(trpc.data.retentionPolicy.queryOptions());
  const linkHours = retention.data?.policy.exportLinkHours ?? 24;

  const exports = useQuery({
    ...trpc.data.exports.queryOptions(),
    enabled: permissions.exportData,
    // Poll while a build is in progress so progress and completion show up.
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) => item.status === "queued" || item.status === "running",
      )
        ? 2000
        : false,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.data.exports.queryKey() });

  const request = useMutation(
    trpc.data.requestExport.mutationOptions({
      onSuccess: refresh,
      onError: (error) =>
        toast({
          duration: 5000,
          variant: "error",
          title: "The export was not started",
          description: error.message,
        }),
    }),
  );

  const download = useMutation(
    trpc.data.exportDownloadUrl.mutationOptions({
      onSuccess: ({ url }) => {
        window.location.assign(url);
      },
      onError: (error) => {
        refresh();
        toast({
          duration: 5000,
          variant: "error",
          title: "The export cannot be downloaded",
          description: error.message,
        });
      },
    }),
  );

  if (!permissions.exportData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Export workspace data</CardTitle>
          <CardDescription>
            Only the workspace owner can export its data.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const items = exports.data ?? [];
  const inProgress = items.some(
    (item) => item.status === "queued" || item.status === "running",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export workspace data</CardTitle>
        <CardDescription>
          Download a ZIP of every original invoice document with its extracted
          data, judgments, suppliers, questions and activity history, described
          by a manifest with checksums. The download is available for{" "}
          {linkHours} hours and then removed.
        </CardDescription>
      </CardHeader>

      <div className="px-6 pb-6 flex flex-col gap-2">
        <div>
          <Button
            size="sm"
            className="text-xs"
            disabled={inProgress || request.isPending}
            onClick={() => request.mutate()}
          >
            {inProgress ? "Export in progress" : "Request export"}
          </Button>
        </div>

        {items.length > 0 ? (
          <div className="divide-y">
            {items.map((item) => (
              <ExportRow
                key={item.id}
                item={item}
                downloading={download.isPending}
                onDownload={(id) => download.mutate({ id })}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** The operating retention schedule, readable by every member. */
export function RetentionSchedule() {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.data.retentionPolicy.queryOptions());

  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Retention</CardTitle>
        <CardDescription>{data.note}</CardDescription>
      </CardHeader>

      <div className="px-6 pb-4 divide-y">
        {data.entries.map((entry) => (
          <div key={entry.key} className="flex flex-col gap-1 py-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">{entry.label}</span>
              <span className="text-sm text-right">{entry.period}</span>
            </div>
            <span className="text-muted-foreground text-xs">
              {entry.appliedBy}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
