"use client";

import { useTRPC } from "@/trpc/client";
import type { RouterOutputs } from "@invoicewise/api/trpc/routers/_app";
import {
  AUTHORIZATION_SOURCE_CSV_TEMPLATE,
  AUTHORIZATION_SOURCE_LIMITS,
} from "@invoicewise/documents/authorization-source";
import { Button } from "@invoicewise/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@invoicewise/ui/dialog";
import { Input } from "@invoicewise/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@invoicewise/ui/table";
import { useToast } from "@invoicewise/ui/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

type Result = RouterOutputs["authorizationSources"]["import"];

const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(
  AUTHORIZATION_SOURCE_CSV_TEMPLATE,
)}`;

/**
 * CSV import: the file is checked in full first (nothing is written), then
 * applied as one unit. One bad row rejects the whole file.
 */
export function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const imports = useQuery(
    trpc.authorizationSources.imports.queryOptions(undefined, {
      enabled: open,
    }),
  );
  const run = useMutation(
    trpc.authorizationSources.import.mutationOptions({
      onSuccess: async (data, variables) => {
        setResult(data);
        if (!variables.dryRun) {
          await queryClient.invalidateQueries({
            queryKey: trpc.authorizationSources.pathKey(),
          });
          if (data.status === "applied") {
            toast({
              title: `Imported ${data.summary.sources} sources`,
              description: `${data.summary.created} created, ${data.summary.amended} amended, ${data.summary.unchanged} unchanged`,
              duration: 4000,
            });
            onOpenChange(false);
          }
        }
      },
      onError: (failure) => setError(failure.message),
    }),
  );

  const choose = async (selected: File | undefined) => {
    setResult(null);
    setError(null);
    if (!selected) return setFile(null);
    if (selected.size > AUTHORIZATION_SOURCE_LIMITS.maxCsvBytes) {
      setFile(null);
      return setError("The file is larger than 2 MB.");
    }
    setFile({ name: selected.name, csv: await selected.text() });
  };

  const submit = (dryRun: boolean) => {
    if (!file) return;
    setError(null);
    run.mutate({ csv: file.csv, fileName: file.name, dryRun });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFile(null);
          setResult(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-[720px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import authorization sources</DialogTitle>
          <DialogDescription>
            One row per authorized line; rows sharing a type and reference are
            one source. A reference already here is amended (a new version) when
            its terms changed and left alone when they did not. The whole file
            is checked first and applied together, or not at all.{" "}
            <a
              className="underline"
              href={templateHref}
              download="authorization-sources-template.csv"
            >
              Download the template
            </a>
            .
          </DialogDescription>
        </DialogHeader>

        <Input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={(event) => choose(event.target.files?.[0])}
        />

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {result && result.status !== "rejected" && (
          <p className="text-sm">
            {result.status === "validated" ? "Ready to import: " : "Imported: "}
            {result.summary.created} new, {result.summary.amended} amended,{" "}
            {result.summary.unchanged} unchanged.
          </p>
        )}

        {result?.status === "rejected" && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              Nothing was imported. Fix these rows and try again.
            </p>
            <div className="max-h-[280px] overflow-y-auto rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[60px]">Row</TableHead>
                    <TableHead className="w-[140px]">Column</TableHead>
                    <TableHead>Problem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.errors.map((item, index) => (
                    <TableRow key={`${item.row}-${item.column}-${index}`}>
                      <TableCell>{item.row ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {item.column ?? "—"}
                      </TableCell>
                      <TableCell>
                        {item.reference ? (
                          <span className="font-medium">
                            {item.reference}:{" "}
                          </span>
                        ) : null}
                        {item.message}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!file || run.isPending}
            onClick={() => submit(true)}
          >
            Check file
          </Button>
          <Button
            disabled={!file || run.isPending || result?.status !== "validated"}
            onClick={() => submit(false)}
          >
            {run.isPending ? "Working…" : "Import"}
          </Button>
        </div>

        {(imports.data?.length ?? 0) > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">
              Recent imports
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {imports.data?.slice(0, 5).map((item) => (
                <li key={item.id}>
                  {new Date(item.createdAt).toLocaleString()} ·{" "}
                  {item.fileName ?? (item.origin === "api" ? "API" : "CSV")} ·{" "}
                  {item.status === "applied"
                    ? "applied"
                    : `rejected (${item.errorCount} problems)`}
                  {item.actorName ? ` · ${item.actorName}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
