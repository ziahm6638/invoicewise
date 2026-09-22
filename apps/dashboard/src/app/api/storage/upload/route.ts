import { getSession } from "@/lib/auth";
import { signedUrl, upload } from "@midday/db/storage";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

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
    !session.teamId ||
    path[0] !== session.teamId
  ) {
    return new NextResponse("Invalid storage path", { status: 403 });
  }

  const result = await upload({ bucket, path, file });
  const url = await signedUrl({
    bucket,
    path,
    expireIn: 60,
  });

  return NextResponse.json({ ...result, url });
}
