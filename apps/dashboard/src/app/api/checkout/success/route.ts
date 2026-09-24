import { getPublicUrl } from "@/utils/environment";
import { safeRedirectPath } from "@/utils/safe-redirect";
import { type NextRequest, NextResponse } from "next/server";

export const GET = async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  // Caller-supplied, so only a same-origin relative path is honoured.
  const redirectPath = safeRedirectPath(searchParams.get("redirectPath"));

  return NextResponse.redirect(getPublicUrl(redirectPath));
};
