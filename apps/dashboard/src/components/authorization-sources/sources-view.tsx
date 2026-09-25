"use client";

import { useTeamPermissions } from "@/hooks/use-team";
import { useTRPC } from "@/trpc/client";
import {
  AUTHORIZATION_SOURCE_STATUSES,
  AUTHORIZATION_SOURCE_TYPES,
} from "@invoicewise/documents/authorization-source";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
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
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { ImportDialog } from "./import-dialog";
import { DateText, GapBadges, Money, StatusBadge, typeLabel } from "./shared";
import { SourceForm } from "./source-form";

const ALL = "__all__";

/** Jobs, purchase orders and contracts, searchable and filterable. */
export function SourcesView() {
  const trpc = useTRPC();
  const permissions = useTeamPermissions();
  const [q, setQ] = useState("");
  const [type, setType] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [gap, setGap] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const search = useDeferredValue(q.trim());

  const query = useInfiniteQuery(
    trpc.authorizationSources.list.infiniteQueryOptions(
      {
        q: search || null,
        type: type === ALL ? null : (type as never),
        status: status === ALL ? null : (status as never),
        gap: gap === ALL ? null : (gap as never),
      },
      { getNextPageParam: (page) => page.meta.cursor },
    ),
  );
  const rows = query.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered =
    Boolean(search) || [type, status, gap].some((v) => v !== ALL);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium">Authorization sources</h1>
          <p className="text-sm text-muted-foreground">
            The jobs, purchase orders and contracts invoices are checked
            against. Every change is kept as a version.
          </p>
        </div>
        {permissions.manageAuthorizationSources && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}>
              Import CSV
            </Button>
            <Button onClick={() => setCreating(true)}>New source</Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-[280px]"
          placeholder="Search reference, title or supplier"
          aria-label="Search authorization sources"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-[170px]" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {AUTHORIZATION_SOURCE_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {typeLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[150px]" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {AUTHORIZATION_SOURCE_STATUSES.map((value) => (
              <SelectItem key={value} value={value} className="capitalize">
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={gap} onValueChange={setGap}>
          <SelectTrigger className="w-[190px]" aria-label="Gaps">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any completeness</SelectItem>
            <SelectItem value="unknown_supplier">Unknown supplier</SelectItem>
            <SelectItem value="missing_currency">No currency</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Authorized</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Effective from</TableHead>
              <TableHead className="text-right">Version</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link
                    href={`/authorizations/${row.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.reference}
                  </Link>
                  {row.title && (
                    <div className="text-xs text-muted-foreground">
                      {row.title}
                    </div>
                  )}
                </TableCell>
                <TableCell>{typeLabel(row.type)}</TableCell>
                <TableCell>
                  {row.supplier ? (
                    row.supplier.name
                  ) : (
                    <div className="space-y-1">
                      {row.suppliedSupplierName && (
                        <div className="text-muted-foreground">
                          {row.suppliedSupplierName}
                        </div>
                      )}
                    </div>
                  )}
                  <GapBadges gaps={row.gaps} />
                </TableCell>
                <TableCell className="text-right">
                  <Money amount={row.authorizedTotal} currency={row.currency} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell>
                  <DateText value={row.effectiveFrom} />
                </TableCell>
                <TableCell className="text-right">v{row.version}</TableCell>
              </TableRow>
            ))}
            {!query.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {filtered
                    ? "No sources match."
                    : "No authorization sources yet. Create one or import a CSV file."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {query.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      {creating && <SourceForm open={creating} onOpenChange={setCreating} />}
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </div>
  );
}
