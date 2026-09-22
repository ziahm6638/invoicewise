import { Inbox } from "@/components/inbox";
import { InboxGetStarted } from "@/components/inbox/inbox-get-started";
import { InboxViewSkeleton } from "@/components/inbox/inbox-skeleton";
import { InboxView } from "@/components/inbox/inbox-view";
import { loadInboxFilterParams } from "@/hooks/use-inbox-filter-params";
import { loadInboxParams } from "@/hooks/use-inbox-params";
import { HydrateClient, getQueryClient, trpc } from "@/trpc/server";
import type { Metadata } from "next";
import type { SearchParams } from "nuqs";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Invoices | InvoiceWise",
};

type Props = {
  searchParams: Promise<SearchParams>;
};

export default async function InvoicesPage({ searchParams }: Props) {
  const queryClient = getQueryClient();
  const values = await searchParams;
  const filter = loadInboxFilterParams(values);
  const params = loadInboxParams(values);
  const data = await queryClient.fetchInfiniteQuery(
    trpc.inbox.get.infiniteQueryOptions({
      order: params.order,
      sort: params.sort,
      ...filter,
    }),
  );

  if (
    !params.connected &&
    data.pages[0]?.data.length === 0 &&
    !Object.values(filter).some((value) => value !== null)
  ) {
    return <InboxGetStarted />;
  }

  return (
    <HydrateClient>
      <Inbox>
        <Suspense fallback={<InboxViewSkeleton />}>
          <InboxView />
        </Suspense>
      </Inbox>
    </HydrateClient>
  );
}
