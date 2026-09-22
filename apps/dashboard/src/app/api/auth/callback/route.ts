import { Cookies } from "@/utils/constants";
import { db } from "@midday/db/client";
import { usersOnTeam } from "@midday/db/schema";
import { LogEvents } from "@midday/events/events";
import { setupAnalytics } from "@midday/events/server";
import { getSession } from "@midday/supabase/cached-queries";
import { createClient } from "@midday/supabase/server";
import { addYears } from "date-fns";
import { count, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  const returnTo = requestUrl.searchParams.get("return_to");
  const provider = requestUrl.searchParams.get("provider");
  const mfaSetupVisited = cookieStore.has(Cookies.MfaSetupVisited);

  if (provider) {
    cookieStore.set(Cookies.PreferredSignInProvider, provider, {
      expires: addYears(new Date(), 1),
    });
  }

  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);

    const {
      data: { session },
    } = await getSession();

    if (session) {
      const userId = session.user.id;

      const analytics = await setupAnalytics({
        userId,
        fullName: session.user.user_metadata?.full_name,
      });

      await analytics.track({
        event: LogEvents.SignIn.name,
        channel: LogEvents.SignIn.channel,
      });

      // If user is redirected from an invite, redirect to teams page to accept/decline the invite
      if (returnTo?.startsWith("teams/invite/")) {
        return NextResponse.redirect(`${requestUrl.origin}/teams`);
      }

      // If user have no teams, redirect to team creation
      const [membership] = await db
        .select({ membershipCount: count() })
        .from(usersOnTeam)
        .where(eq(usersOnTeam.userId, userId));

      if (
        membership?.membershipCount === 0 &&
        !returnTo?.startsWith("teams/invite/")
      ) {
        return NextResponse.redirect(`${requestUrl.origin}/teams/create`);
      }
    }
  }

  if (!mfaSetupVisited) {
    cookieStore.set(Cookies.MfaSetupVisited, "true", {
      expires: addYears(new Date(), 1),
    });

    return NextResponse.redirect(`${requestUrl.origin}/mfa/setup`);
  }

  if (returnTo) {
    return NextResponse.redirect(`${requestUrl.origin}/${returnTo}`);
  }

  return NextResponse.redirect(requestUrl.origin);
}
