"use client";

import { useInboxParams } from "@/hooks/use-inbox-params";
import { Button } from "@midday/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { ArrowUpDown } from "lucide-react";

export function InboxOrdering() {
  const { params, setParams } = useInboxParams();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Sort invoices">
          <ArrowUpDown aria-hidden className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={params.sort === "date" && params.order === "desc"}
          onCheckedChange={() => setParams({ sort: "date", order: "desc" })}
        >
          Newest received
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={params.sort === "date" && params.order === "asc"}
          onCheckedChange={() => setParams({ sort: "date", order: "asc" })}
        >
          Oldest received
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={params.sort === "amount" && params.order === "desc"}
          onCheckedChange={() => setParams({ sort: "amount", order: "desc" })}
        >
          Highest amount
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={params.sort === "amount" && params.order === "asc"}
          onCheckedChange={() => setParams({ sort: "amount", order: "asc" })}
        >
          Lowest amount
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
