import { WebhookEndpoints } from "@/components/webhook-endpoints";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Webhooks | InvoiceWise",
};

export default async function WebhooksSettingsPage() {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );

  // Webhook endpoints are workspace integrations: admin and up.
  if (!team?.permissions?.manageIntegrations) {
    return (
      <p className="text-sm text-[#606060]">
        Only workspace owners and admins can manage webhooks.
      </p>
    );
  }

  prefetch(trpc.webhooks.list.queryOptions());

  return <WebhookEndpoints />;
}
