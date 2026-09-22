import { db } from "@midday/db/client";
import { getUserTeamId } from "@midday/db/queries";
import { download } from "@midday/db/storage";
import { createClient } from "@midday/supabase/server";
import type { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const requestUrl = new URL(req.url);
  const path = requestUrl.searchParams.get("path");
  const filename = requestUrl.searchParams.get("filename");

  if (!path) {
    return new Response("Path is required", { status: 400 });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const teamId = await getUserTeamId(db, session.user.id);
  if (!teamId || path.split("/")[0] !== teamId) {
    return new Response("Forbidden", { status: 403 });
  }

  const data = await download({
    bucket: "vault",
    path,
  });

  const responseHeaders = new Headers();

  responseHeaders.set(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );

  return new Response(data, {
    headers: responseHeaders,
  });
}
