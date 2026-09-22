"use client";

import { InboxDetailsSkeleton } from "./inbox-details-skeleton";
import { InboxListSkeleton } from "./inbox-list-skeleton";

export function InboxViewSkeleton() {
  return (
    <div className="grid h-[calc(100vh-138px)] min-h-0 gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
      <div className="h-full overflow-hidden border">
        <InboxListSkeleton numberOfItems={7} />
      </div>

      <InboxDetailsSkeleton />
    </div>
  );
}
