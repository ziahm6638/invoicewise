import { SourceDetail } from "@/components/authorization-sources/source-detail";
import { HydrateClient, getQueryClient, trpc } from "@/trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Authorization source | InvoiceWise",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AuthorizationSourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const source = await getQueryClient()
    .fetchQuery(trpc.authorizationSources.get.queryOptions({ id }))
    .catch(() => null);
  if (!source) notFound();

  return (
    <HydrateClient>
      <main className="max-w-[1100px] pt-4">
        <SourceDetail id={id} />
      </main>
    </HydrateClient>
  );
}
