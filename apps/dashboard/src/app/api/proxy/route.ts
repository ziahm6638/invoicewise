import { db } from "@midday/db/client";
import { getUserTeamId } from "@midday/db/queries";
import { download } from "@midday/db/storage";
import { getSession } from "@midday/supabase/cached-queries";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const requestUrl = new URL(req.url);
  const filePath = requestUrl.searchParams.get("filePath");

  const {
    data: { session },
  } = await getSession();

  if (!session || !filePath) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const path = filePath.replace(/^vault\//, "");
  const teamId = await getUserTeamId(db, session.user.id);
  if (!teamId || path.split("/")[0] !== teamId) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const data = await download({
      bucket: "vault",
      path,
    });
    return new NextResponse(data, {
      headers: { "Content-Type": data.type },
    });
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }
}
