import { InboxConnectedAccounts } from "@/components/inbox/inbox-connected-accounts";
import { InboxEmailSettings } from "@/components/inbox/inbox-email-settings";
import { prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Email Settings | InvoiceWise",
};

export default function EmailSettingsPage() {
  prefetch(trpc.inboundEmail.get.queryOptions());
  prefetch(trpc.inboxAccounts.get.queryOptions());

  return (
    <div className="space-y-12">
      <InboxEmailSettings />
      <InboxConnectedAccounts />
    </div>
  );
}
