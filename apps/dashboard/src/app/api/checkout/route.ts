import { getSession } from "@/lib/auth";
import { getPublicUrl } from "@/utils/environment";
import { getDiscount, getPlans } from "@/utils/plans";
import { api } from "@/utils/polar";
import { safeRedirectPath } from "@/utils/safe-redirect";
import { db } from "@invoicewise/db/client";
import { canManageBilling, getTeamById } from "@invoicewise/db/queries";
import { type NextRequest, NextResponse } from "next/server";

export const GET = async (req: NextRequest) => {
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

  const plan = req.nextUrl.searchParams.get("plan");
  const redirectPath = safeRedirectPath(
    req.nextUrl.searchParams.get("redirectPath"),
  );
  const teamId = req.nextUrl.searchParams.get("teamId");
  const planType = req.nextUrl.searchParams.get("planType");

  const plans = getPlans();

  const selectedPlan = plans[plan as keyof typeof plans];

  if (!selectedPlan) {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  if (!teamId || teamId !== session.teamId) {
    return NextResponse.json({ error: "Team not found" }, { status: 403 });
  }

  const team = await getTeamById(db, teamId);

  if (!team) {
    return NextResponse.json({ error: "Team not found" }, { status: 403 });
  }

  const discountId = getDiscount(planType);

  const successUrl = getPublicUrl("/api/checkout/success");
  successUrl.searchParams.set("redirectPath", redirectPath);

  const checkout = await api.checkouts.create({
    products: [selectedPlan.id],
    successUrl: successUrl.toString(),
    customerExternalId: team.id,
    customerEmail: session.user.email ?? undefined,
    customerName: team.name ?? undefined,
    discountId: discountId?.id,
    metadata: {
      teamId: team.id,
      companyName: team.name ?? "",
    },
  });

  return NextResponse.redirect(checkout.url);
};
