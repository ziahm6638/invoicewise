import { getSession } from "@/lib/auth";
import { api } from "@/utils/polar";
import { canManageBilling } from "@invoicewise/db/queries";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const session = await getSession();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  // Billing stays with the workspace owner, checked live on this endpoint so
  // the dashboard/tRPC gate cannot be bypassed by calling the route directly.
  if (!canManageBilling(session.teamRole)) {
    return NextResponse.json(
      { error: "Only the workspace owner can manage billing" },
      { status: 403 },
    );
  }

  const teamId = req.nextUrl.searchParams.get("id");

  if (!teamId || teamId !== session.teamId) {
    return NextResponse.json({ error: "Team not found" }, { status: 403 });
  }

  const result = await api.customerSessions.create({
    customerExternalId: teamId,
  });

  return NextResponse.redirect(result.customerPortalUrl);
}
