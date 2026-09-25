import { Header } from "@/components/header";
import { SecondaryMenu } from "@/components/secondary-menu";
import { getQueryClient, trpc } from "@/trpc/server";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );

  // The nav mirrors the server's decision; every route re-checks on the server.
  const permissions = team?.permissions;

  const items = [
    { path: "/settings", label: "General" },
    { path: "/settings/email", label: "Email" },
    { path: "/settings/data", label: "Data" },
    { path: "/settings/delivery", label: "Delivery rules" },
    ...(permissions?.manageBilling
      ? [{ path: "/settings/billing", label: "Billing" }]
      : []),
    ...(permissions?.manageMembers
      ? [{ path: "/settings/members", label: "Members" }]
      : []),
    ...(permissions?.manageIntegrations
      ? [
          { path: "/settings/accounting", label: "Accounting" },
          { path: "/settings/bank-payments", label: "Bank payments" },
          { path: "/settings/webhooks", label: "Webhooks" },
          { path: "/settings/developer", label: "Developer" },
        ]
      : []),
    ...(permissions?.readAuditLog
      ? [{ path: "/settings/audit", label: "Audit log" }]
      : []),
  ];

  return (
    <div className="max-w-[800px]">
      <SecondaryMenu items={items} />

      <main className="mt-8">{children}</main>
    </div>
  );
}
