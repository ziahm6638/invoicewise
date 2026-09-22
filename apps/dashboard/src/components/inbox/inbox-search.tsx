"use client";

import { useInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { Button } from "@midday/ui/button";
import { cn } from "@midday/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@midday/ui/dropdown-menu";
import { Input } from "@midday/ui/input";
import { CalendarDays, Search, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

export function InboxSearch() {
  const [isOpen, setIsOpen] = useState(false);
  const { params, setParams, hasFilter } = useInboxFilterParams();

  useHotkeys("esc", () => setParams({ q: null }), {
    enableOnFormTags: true,
    enabled: Boolean(params.q),
  });

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <form
        className="relative w-full max-w-xl"
        onSubmit={(event) => event.preventDefault()}
      >
        <Search
          aria-hidden
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search invoices by supplier"
          placeholder="Search suppliers"
          className="pl-9 pr-10"
          value={params.q ?? ""}
          onChange={(event) => setParams({ q: event.target.value || null })}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck="false"
        />

        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Filter invoices by received date"
              className={cn(
                "absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
                (params.dateFrom || params.dateTo) && "text-foreground",
              )}
            >
              <SlidersHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 p-4" sideOffset={8}>
            <div className="mb-3 flex items-center gap-2">
              <CalendarDays
                aria-hidden
                className="size-4 text-muted-foreground"
              />
              <p className="text-sm font-medium">Date received</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label
                htmlFor="received-from"
                className="space-y-1.5 text-xs text-muted-foreground"
              >
                From
                <Input
                  id="received-from"
                  type="date"
                  value={params.dateFrom ?? ""}
                  onChange={(event) =>
                    setParams({ dateFrom: event.target.value || null })
                  }
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </label>
              <label
                htmlFor="received-to"
                className="space-y-1.5 text-xs text-muted-foreground"
              >
                To
                <Input
                  id="received-to"
                  type="date"
                  value={params.dateTo ?? ""}
                  onChange={(event) =>
                    setParams({ dateTo: event.target.value || null })
                  }
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </label>
            </div>
            {(params.dateFrom || params.dateTo) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setParams({ dateFrom: null, dateTo: null })}
              >
                <X aria-hidden className="mr-2 size-3.5" />
                Clear dates
              </Button>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </form>

      {hasFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="hidden shrink-0 sm:flex"
          onClick={() => setParams(null)}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
