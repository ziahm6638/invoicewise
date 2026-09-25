import { BankPayments } from "@/components/bank-payments";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bank payments | InvoiceWise",
};

export default async function BankPaymentsSettingsPage() {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );

  // Bank connections are workspace integrations: admin and up.
  if (!team?.permissions?.manageIntegrations) {
    return (
      <p className="text-sm text-[#606060]">
        Only workspace owners and admins can manage bank payments.
      </p>
    );
  }

  prefetch(trpc.bankPayments.overview.queryOptions());

  return <BankPayments />;
}
