import { getSession } from "@/lib/auth";
import { api } from "@/utils/polar";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const session = await getSession();

  if (!session?.user?.id) {
    throw new Error("You must be logged in");
  }

  const teamId = req.nextUrl.searchParams.get("id");

  if (!teamId || teamId !== session.teamId) {
    throw new Error("Team ID is required");
  }

  const result = await api.customerSessions.create({
    customerExternalId: teamId,
  });

  return NextResponse.redirect(result.customerPortalUrl);
}
