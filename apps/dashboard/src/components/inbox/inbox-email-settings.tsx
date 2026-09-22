"use client";

import { CopyInput } from "@/components/copy-input";
import { useUserQuery } from "@/hooks/use-user";
import { getInboxEmail } from "@midday/inbox";
import { Card, CardDescription, CardHeader, CardTitle } from "@midday/ui/card";

export function InboxEmailSettings() {
  const { data: user } = useUserQuery();
  const inboxEmail = getInboxEmail(user?.team?.inboxId ?? "");

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
