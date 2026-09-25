"use client";

import { useInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { Button } from "@invoicewise/ui/button";
import { Icons } from "@invoicewise/ui/icons";

export function NoResults() {
  const { setParams } = useInboxFilterParams();

  return (
    <div className="flex h-[calc(100vh-138px)] w-full flex-col items-center justify-center border">
      <div className="flex flex-col items-center">
        <Icons.Transactions2 className="mb-4" />
        <div className="text-center mb-6 space-y-2">
          <h2 className="font-medium text-lg">No invoices match</h2>
          <p className="text-[#606060] text-sm">
            Try another supplier, invoice number, state or received date.
          </p>
        </div>

        <Button variant="outline" onClick={() => setParams(null)}>
          Clear filters
        </Button>
      </div>
    </div>
  );
}
