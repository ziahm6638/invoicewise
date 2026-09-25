import { AuditLog } from "@/components/audit-log";
import { getQueryClient, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Audit log | InvoiceWise",
};

export default async function AuditLogSettingsPage() {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );

  // The audit trail names every member's actions: admin and up.
  if (!team?.permissions?.readAuditLog) {
    return (
      <p className="text-sm text-[#606060]">
        Only workspace owners and admins can read the audit log.
      </p>
    );
  }

  return <AuditLog />;
}
