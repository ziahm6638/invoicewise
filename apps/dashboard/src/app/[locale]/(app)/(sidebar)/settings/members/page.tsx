import { TeamMembers } from "@/components/team-members";
import { getQueryClient, prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Members | InvoiceWise",
};

export default async function Members() {
  const team = await getQueryClient().fetchQuery(
    trpc.team.current.queryOptions(),
  );
  const canManageMembers = team?.permissions?.manageMembers ?? false;

  prefetch(trpc.team.members.queryOptions());

  if (canManageMembers) {
    prefetch(trpc.team.teamInvites.queryOptions());
  }

  return <TeamMembers canManageMembers={canManageMembers} />;
}
