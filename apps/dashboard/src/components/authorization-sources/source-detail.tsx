"use client";

import { useTRPC } from "@/trpc/client";
import { formatSize } from "@/utils/format";
import type { RouterOutputs } from "@invoicewise/api/trpc/routers/_app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@invoicewise/ui/alert-dialog";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@invoicewise/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@invoicewise/ui/table";
import { useToast } from "@invoicewise/ui/use-toast";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import {
  DateText,
  GapBadges,
  Money,
  StatusBadge,
  taxBasisLabel,
  typeLabel,
} from "./shared";
import { SourceForm } from "./source-form";

type Version = RouterOutputs["authorizationSources"]["version"];

const ORIGIN_LABEL: Record<string, string> = {
  manual: "Entered in InvoiceWise",
  csv: "CSV import",
  api: "API",
};

function VersionTerms({ version }: { version: Version }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Supplier</dt>
          <dd>
            {version.supplier?.name ??
              version.suppliedSupplier.name ??
              "Not given"}
            {version.suppliedSupplier.vatNumber && (
              <div className="text-xs text-muted-foreground">
                VAT {version.suppliedSupplier.vatNumber}
              </div>
            )}
            {version.suppliedSupplier.companyNumber && (
              <div className="text-xs text-muted-foreground">
                Company {version.suppliedSupplier.companyNumber}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {String(version.supplierResolution.message ?? "")}
            </div>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Authorized total</dt>
          <dd className="font-medium">
            <Money
              amount={version.authorizedTotal}
              currency={version.currency}
            />
          </dd>
          <dd className="text-xs text-muted-foreground">
            {version.currency ?? "No currency given"} ·{" "}
            {taxBasisLabel(version.taxBasis)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge status={version.status} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Issued</dt>
          <dd>
            <DateText value={version.issuedOn} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Period</dt>
          <dd>
            {version.startsOn || version.endsOn ? (
              <>
                <DateText value={version.startsOn} /> –{" "}
                <DateText value={version.endsOn} />
              </>
            ) : (
              <span className="text-muted-foreground">Not given</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Effective from</dt>
          <dd>
            <DateText value={version.effectiveFrom} />
          </dd>
        </div>
        {version.scope && (
          <div className="md:col-span-3">
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="whitespace-pre-wrap">{version.scope}</dd>
          </div>
        )}
      </dl>
      <GapBadges gaps={version.gaps} />
      {version.lines.length > 0 && (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">Ref</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {version.lines.map((line, index) => (
                <TableRow key={`${line.reference ?? ""}-${index}`}>
                  <TableCell>{line.reference ?? "—"}</TableCell>
                  <TableCell>{line.description}</TableCell>
                  <TableCell className="text-right">
                    {line.quantity ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {line.unitPrice ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money amount={line.amount} currency={version.currency} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function SourceDetail({ id }: { id: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: source } = useSuspenseQuery(
    trpc.authorizationSources.get.queryOptions({ id }),
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [effectiveOn, setEffectiveOn] = useState("");
  const [amending, setAmending] = useState(false);
  const [statusChange, setStatusChange] = useState<
    "open" | "closed" | "cancelled" | null
  >(null);
  const [reason, setReason] = useState("");
  const [linkTo, setLinkTo] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const shownNumber = selected ?? source.current.version;
  const shown = useQuery(
    trpc.authorizationSources.version.queryOptions(
      { id, version: shownNumber },
      { enabled: shownNumber !== source.current.version },
    ),
  );
  const effective = useQuery(
    trpc.authorizationSources.effective.queryOptions(
      { id, on: effectiveOn },
      { enabled: /^\d{4}-\d{2}-\d{2}$/.test(effectiveOn) },
    ),
  );
  const suppliers = useQuery(
    trpc.suppliers.list.queryOptions(undefined, {
      enabled: source.canManage && !source.current.supplier,
    }),
  );

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.authorizationSources.pathKey(),
    });
  const onError = (failure: { message: string }) =>
    toast({ title: failure.message, variant: "error", duration: 5000 });

  const setStatus = useMutation(
    trpc.authorizationSources.setStatus.mutationOptions({
      onSuccess: async (result) => {
        await refresh();
        setStatusChange(null);
        setReason("");
        setSelected(null);
        toast({
          title:
            result.outcome === "unchanged"
              ? "Nothing changed"
              : `Marked ${result.status} (version ${result.version})`,
          duration: 3500,
        });
      },
      onError,
    }),
  );
  const link = useMutation(
    trpc.authorizationSources.linkSupplier.mutationOptions({
      onSuccess: async (result) => {
        await refresh();
        setSelected(null);
        toast({
          title: `Supplier linked (version ${result.version})`,
          duration: 3500,
        });
      },
      onError,
    }),
  );

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.set("sourceId", id);
      form.set("file", file);
      const response = await fetch("/api/authorization-sources/documents", {
        method: "POST",
        body: form,
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        deduplicated?: boolean;
      };
      if (!response.ok) {
        onError({ message: body.error ?? "The document could not be kept" });
        return;
      }
      await refresh();
      toast({
        title: body.deduplicated
          ? "This document is already attached"
          : "Document attached",
        duration: 3500,
      });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const status = source.current.status;
  const shownVersion =
    shownNumber === source.current.version ? source.current : shown.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/authorizations"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Authorization sources
          </Link>
          <h1 className="text-lg font-medium">
            {typeLabel(source.type)} {source.reference}
          </h1>
          {source.current.title && (
            <p className="text-sm text-muted-foreground">
              {source.current.title}
            </p>
          )}
        </div>
        {source.canManage && (
          <div className="flex flex-wrap gap-2">
            {status !== "cancelled" && (
              <Button variant="outline" onClick={() => setAmending(true)}>
                Amend
              </Button>
            )}
            {status === "open" && (
              <Button
                variant="outline"
                onClick={() => setStatusChange("closed")}
              >
                Close
              </Button>
            )}
            {status === "closed" && (
              <Button variant="outline" onClick={() => setStatusChange("open")}>
                Reopen
              </Button>
            )}
            {status !== "cancelled" && (
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => setStatusChange("cancelled")}
              >
                Cancel source
              </Button>
            )}
          </div>
        )}
      </div>

      {source.canManage &&
        !source.current.supplier &&
        status !== "cancelled" && (
          <div className="flex flex-wrap items-end gap-2 rounded border border-amber-500/40 p-3">
            <div className="space-y-1">
              <Label htmlFor="link-supplier">
                Link to a workspace supplier
              </Label>
              <Select value={linkTo} onValueChange={setLinkTo}>
                <SelectTrigger id="link-supplier" className="w-[260px]">
                  <SelectValue placeholder="Choose a supplier" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.data?.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!linkTo || link.isPending}
              onClick={() => link.mutate({ id, supplierId: linkTo })}
            >
              Link supplier
            </Button>
          </div>
        )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Version {shownNumber}
            {shownNumber === source.current.version
              ? " (current)"
              : ` of ${source.current.version}`}
          </h2>
          {shownNumber !== source.current.version && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Show current
            </Button>
          )}
        </div>
        {shownVersion ? (
          <VersionTerms version={shownVersion} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Versions</h2>
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">Version</TableHead>
                <TableHead>Effective from</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Authorized</TableHead>
                <TableHead>Change</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {source.versions.map((version) => (
                <TableRow
                  key={version.id}
                  className="cursor-pointer"
                  data-state={
                    version.version === shownNumber ? "selected" : undefined
                  }
                  onClick={() => setSelected(version.version)}
                >
                  <TableCell>v{version.version}</TableCell>
                  <TableCell>
                    <DateText value={version.effectiveFrom} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={version.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      amount={version.authorizedTotal}
                      currency={version.currency}
                    />
                  </TableCell>
                  <TableCell className="text-sm">
                    {version.changeReason ??
                      (version.version === 1 ? "Created" : "—")}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(version.recordedAt).toLocaleString()} ·{" "}
                    {ORIGIN_LABEL[version.origin] ?? version.origin}
                    {version.recordedBy ? ` · ${version.recordedBy}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="effective-on">Version in effect on</Label>
            <Input
              id="effective-on"
              type="date"
              className="w-[180px]"
              value={effectiveOn}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
          </div>
          {effective.data !== undefined && effectiveOn && (
            <p className="pb-2 text-sm">
              {effective.data ? (
                <button
                  type="button"
                  className="underline"
                  onClick={() => setSelected(effective.data!.version)}
                >
                  Version {effective.data.version}
                </button>
              ) : (
                "No version was in effect on that date."
              )}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Source documents</h2>
          {source.canManage && status !== "cancelled" && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="hidden"
                onChange={(event) => upload(event.target.files?.[0])}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? "Uploading…" : "Attach document"}
              </Button>
            </>
          )}
        </div>
        {source.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No signed order, contract or other evidence attached.
          </p>
        ) : (
          <ul className="divide-y rounded border text-sm">
            {source.documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <a
                  className="hover:underline"
                  href={`/api/authorization-sources/documents?sourceId=${id}&documentId=${document.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {document.fileName}
                </a>
                <span className="text-xs text-muted-foreground">
                  v{document.version} · {formatSize(document.size)} ·{" "}
                  {new Date(document.createdAt).toLocaleDateString()}
                  {document.uploadedByName
                    ? ` · ${document.uploadedByName}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {amending && (
        <SourceForm
          open={amending}
          onOpenChange={setAmending}
          amend={{
            id,
            type: source.type,
            reference: source.reference,
            current: source.current,
          }}
        />
      )}

      <AlertDialog
        open={statusChange !== null}
        onOpenChange={(open) => !open && setStatusChange(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusChange === "cancelled"
                ? `Cancel ${source.reference}?`
                : statusChange === "closed"
                  ? `Close ${source.reference}?`
                  : `Reopen ${source.reference}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {statusChange === "cancelled"
                ? "A cancelled source can no longer be amended or reopened. Its versions stay available."
                : "This is recorded as a new version with the same terms."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="Reason"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={setStatus.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (statusChange) {
                  setStatus.mutate({
                    id,
                    status: statusChange,
                    reason: reason.trim() || null,
                  });
                }
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
