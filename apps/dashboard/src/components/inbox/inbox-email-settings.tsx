"use client";

import { CopyInput } from "@/components/copy-input";
import { useTeamQuery } from "@/hooks/use-team";
import { getInboxEmail } from "@invoicewise/inbox";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";

export function InboxEmailSettings() {
  const { data: team } = useTeamQuery();
  const inboxEmail = getInboxEmail(team?.inboxId ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email Address</CardTitle>
        <CardDescription>
          Forward supplier invoices to this address for automatic processing.
          Emails sent to this address will automatically appear in your inbox
          and will be extracted automatically.
        </CardDescription>
      </CardHeader>

      <div className="px-6 pb-6 max-w-[400px]">
        <CopyInput value={inboxEmail} />
      </div>
    </Card>
  );
}
