"use client";

import { invoiceStateFilters } from "@/components/inbox/invoice-state";
import { useInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { Button } from "@invoicewise/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@invoicewise/ui/dropdown-menu";
import { ListFilter } from "lucide-react";

/** Narrows the list to one exception state, kept in the URL across reloads. */
export function InboxStateFilter() {
  const { params, setParams } = useInboxFilterParams();
  const active = invoiceStateFilters.find(
    (filter) => filter.value === params.state,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={active ? "secondary" : "outline"}
          className="shrink-0"
          aria-label="Filter invoices by state"
        >
          <ListFilter aria-hidden className="size-4 sm:mr-2" />
          <span className="hidden sm:inline">
            {active?.label ?? "All states"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuRadioGroup
          value={params.state ?? "all"}
          onValueChange={(value) =>
            setParams({
              state:
                value === "all"
                  ? null
                  : (value as (typeof invoiceStateFilters)[number]["value"]),
            })
          }
        >
          <DropdownMenuRadioItem value="all">All states</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {invoiceStateFilters.map((filter) => (
            <DropdownMenuRadioItem key={filter.value} value={filter.value}>
              {filter.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
