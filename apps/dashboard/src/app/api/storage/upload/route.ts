import { db } from "@midday/db/client";
import { getUserById } from "@midday/db/queries";
import { signedUrl, upload } from "@midday/db/storage";
import { getSession } from "@midday/supabase/cached-queries";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const {
    data: { session },
  } = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const user = await getUserById(db, session.user.id);
  const formData = await request.formData();
  const file = formData.get("file");
  const bucket = formData.get("bucket");
  const rawPath = formData.get("path");

  if (
    !(file instanceof File) ||
    bucket !== "vault" ||
    typeof rawPath !== "string"
  ) {
    return new NextResponse("Invalid upload", { status: 400 });
  }

  let path: unknown;
  try {
    path = JSON.parse(rawPath);
  } catch {
    return new NextResponse("Invalid storage path", { status: 400 });
  }

  if (
    !Array.isArray(path) ||
    path.some((part) => typeof part !== "string") ||
    !user?.teamId ||
    path[0] !== user.teamId
  ) {
    return new NextResponse("Invalid storage path", { status: 403 });
  }

  const result = await upload({ bucket, path, file });
  const url = await signedUrl({
    bucket,
    path,
    expireIn: 365 * 24 * 60 * 60,
  });

  return NextResponse.json({ ...result, url });
}
