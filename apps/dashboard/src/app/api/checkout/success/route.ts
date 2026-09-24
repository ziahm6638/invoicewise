import { safeRedirectPath } from "@/utils/safe-redirect";
import { type NextRequest, NextResponse } from "next/server";

export const GET = async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  // Caller-supplied, so only a same-origin relative path is honoured.
  const redirectPath = safeRedirectPath(searchParams.get("redirectPath"));

  return NextResponse.redirect(new URL(redirectPath, req.url));
};
