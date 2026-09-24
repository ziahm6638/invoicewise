import { AccountingConnections } from "@/components/accounting-connections";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Accounting | InvoiceWise",
};

export default async function AccountingSettingsPage() {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );

  // Accounting connections are workspace integrations: admin and up.
  if (!team?.permissions?.manageIntegrations) {
    return (
      <p className="text-sm text-[#606060]">
        Only workspace owners and admins can manage accounting connections.
      </p>
    );
  }

  prefetch(trpc.accounting.get.queryOptions());

  return <AccountingConnections />;
}
