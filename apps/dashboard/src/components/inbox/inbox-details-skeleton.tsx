"use client";

import { Separator } from "@invoicewise/ui/separator";
import { Skeleton } from "@invoicewise/ui/skeleton";

export function InboxDetailsSkeleton() {
  return (
    <div className="hidden h-full min-h-0 overflow-hidden border lg:flex lg:flex-col">
      <div className="h-[72px] w-full p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-3 w-56" />
      </div>

      <Separator />
      <div className="flex flex-1 flex-col">
        <div className="grid min-h-0 flex-1 xl:grid-cols-2">
          <Skeleton className="m-5" />
          <div className="space-y-4 border-l p-5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
