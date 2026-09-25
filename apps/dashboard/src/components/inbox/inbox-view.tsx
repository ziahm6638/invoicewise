"use client";

import { LoadMore } from "@/components/load-more";
import { useInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { useInboxParams } from "@/hooks/use-inbox-params";
import { useRealtime } from "@/hooks/use-realtime";
import { useUserQuery } from "@/hooks/use-user";
import { useTRPC } from "@/trpc/client";
import { ScrollArea } from "@invoicewise/ui/scroll-area";
import {
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useInView } from "react-intersection-observer";
import { useDebounceCallback } from "usehooks-ts";
import { BulkActions } from "./bulk-actions";
import { InboxDetails } from "./inbox-details";
import { NoResults } from "./inbox-empty";
import { InboxItem } from "./inbox-item";
import { InboxViewSkeleton } from "./inbox-skeleton";

export function InboxView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { ref, inView } = useInView();
  const { data: user } = useUserQuery();
  const { params, setParams } = useInboxParams();
  const { params: filter, hasFilter } = useInboxFilterParams();
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // Selection survives loading more pages; a changed filter starts afresh.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const filterKey = JSON.stringify([filter, params.sort, params.order]);
  useEffect(() => {
    setSelected(new Set());
  }, [filterKey]);

  const options = trpc.inbox.get.infiniteQueryOptions(
    { order: params.order, sort: params.sort, ...filter },
    { getNextPageParam: ({ meta }) => meta?.cursor },
  );
  const { data, fetchNextPage, hasNextPage, refetch } =
    useSuspenseInfiniteQuery(options);
  const invoices = useMemo(
    () => data.pages.flatMap((page) => page.data),
    [data],
  );
  const refresh = useDebounceCallback(() => {
    refetch();
    queryClient.invalidateQueries({
      queryKey: trpc.inbox.getById.queryKey(),
    });
  }, 200);

  useRealtime({
    channelName: "realtime_inbox",
    table: "inbox",
    filter: `team_id=eq.${user?.teamId}`,
    onEvent: ({ eventType }) => {
      if (eventType === "INSERT" || eventType === "UPDATE") refresh();
    },
  });

  useEffect(() => {
    if (inView && hasNextPage) fetchNextPage();
  }, [fetchNextPage, hasNextPage, inView]);

  useEffect(() => {
    if (!params.inboxId && invoices[0]) {
      setParams({ inboxId: invoices[0].id });
    }
  }, [invoices, params.inboxId, setParams]);

  const selectOffset = (offset: number) => {
    const current = invoices.findIndex(({ id }) => id === params.inboxId);
    const next = invoices[current + offset];
    if (!next) return;
    setParams({ inboxId: next.id });
    requestAnimationFrame(() =>
      itemRefs.current.get(next.id)?.scrollIntoView({ block: "nearest" }),
    );
  };

  useHotkeys("up", (event) => {
    event.preventDefault();
    selectOffset(-1);
  });
  useHotkeys("down", (event) => {
    event.preventDefault();
    selectOffset(1);
  });

  if (params.connected && !invoices.length) return <InboxViewSkeleton />;
  if (hasFilter && !invoices.length) return <NoResults />;

  return (
    <div className="grid h-[calc(100vh-138px)] min-h-0 gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border">
        <BulkActions
          invoices={invoices}
          selected={selected}
          onSelectedChange={setSelected}
        />
        <ScrollArea className="min-h-0 flex-1 overflow-hidden" hideScrollbar>
          <ul aria-label="Invoices">
            {invoices.map((item, index) => (
              <li key={item.id}>
                <InboxItem
                  ref={(node) => {
                    if (node) itemRefs.current.set(item.id, node);
                    else itemRefs.current.delete(item.id);
                  }}
                  item={item}
                  index={index}
                  checked={selected.has(item.id)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected);
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                    setSelected(next);
                  }}
                />
              </li>
            ))}
          </ul>
          <LoadMore ref={ref} hasNextPage={hasNextPage} />
        </ScrollArea>
      </div>

      <InboxDetails />
    </div>
  );
}
