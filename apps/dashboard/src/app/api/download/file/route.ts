import { getSession } from "@/lib/auth";
import { download } from "@midday/db/storage";
import type { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const requestUrl = new URL(req.url);
  const path = requestUrl.searchParams.get("path");
  const filename = requestUrl.searchParams.get("filename");

  if (!path) {
    return new Response("Path is required", { status: 400 });
  }

  const session = await getSession();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!session.teamId || path.split("/")[0] !== session.teamId) {
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
