/**
 * Asset storage must never become a raw invoice read.
 *
 * These checks drive the real route handlers with a stubbed session and a
 * stubbed vault, so the path shape and read policy are exercised directly.
 */
import { describe, expect, mock, test } from "bun:test";
import sharp from "sharp";

let currentSession: {
  teamId: string | null;
  user: { id: string; email: string; full_name: string };
  teamRole?: string;
} | null = null;

mock.module("@/lib/auth", () => ({
  getSession: async () => currentSession,
}));

const uploads: { path: string[]; contentType?: string }[] = [];

// Keep the real module surface (the intake service also imports `remove`) and
// stub only the object store this route talks to.
const realStorage = await import("@invoicewise/db/storage");

mock.module("@invoicewise/db/storage", () => ({
  ...realStorage,
  download: async ({ path }: { path: string | string[] }) => {
    const joined = Array.isArray(path) ? path.join("/") : path;
    if (joined.includes("missing")) throw new Error("not found");
    return new Blob([Buffer.from("asset-bytes")], { type: "image/png" });
  },
  uploadIfAbsent: async (input: { path: string[]; contentType?: string }) => {
    uploads.push({ path: input.path, contentType: input.contentType });
    return { path: input.path, created: true };
  },
}));

const { GET, POST } = await import("./route");

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const session = (teamId: string | null, userId = USER) => ({
  teamId,
  user: { id: userId, email: "user@example.test", full_name: "User" },
});

const getAsset = (path: string) =>
  GET(
    new Request(
      `http://localhost/api/storage/asset?path=${encodeURIComponent(path)}`,
    ),
  );

const postAsset = async (
  kind: string,
  bytes: Uint8Array,
  name = "logo.png",
) => {
  const formData = new FormData();
  formData.set("kind", kind);
  formData.set(
    "file",
    new File([Buffer.from(bytes)], name, { type: "image/png" }),
  );
  return POST(
    new Request("http://localhost/api/storage/asset", {
      method: "POST",
      body: formData,
    }),
  );
};

describe("asset route boundary", () => {
  test("never serves an invoice object, even for the owning workspace", async () => {
    currentSession = session(TEAM);

    const inboxPath = `${TEAM}/inbox/44444444-4444-4444-8444-444444444444/invoice.pdf`;
    expect((await getAsset(inboxPath)).status).toBe(404);

    // Near-miss shapes are also refused: an assets branch with the wrong
    // number of segments, a nested invoice path, traversal and unknown kinds.
    expect((await getAsset(`${TEAM}/assets/logo/4444`)).status).toBe(404);
    expect(
      (await getAsset(`${TEAM}/inbox/4444/logo.png/assets/logo/x/y`)).status,
    ).toBe(404);
    expect((await getAsset("../etc/passwd")).status).toBe(404);
    expect((await getAsset(`${TEAM}/assets/not-a-kind/1/f.png`)).status).toBe(
      404,
    );
  });

  test("team assets are readable only by their workspace", async () => {
    currentSession = session(TEAM);
    const teamAsset = `${TEAM}/assets/logo/44444444-4444-4444-8444-444444444444/logo.png`;
    expect((await getAsset(teamAsset)).status).toBe(200);

    currentSession = session(OTHER_TEAM);
    expect((await getAsset(teamAsset)).status).toBe(403);

    currentSession = null;
    expect((await getAsset(teamAsset)).status).toBe(401);
  });

  test("avatars are readable by signed-in sessions and app logos are public", async () => {
    const avatar = `${USER}/assets/avatar/44444444-4444-4444-8444-444444444444/a.png`;
    currentSession = session(TEAM, "55555555-5555-4555-8555-555555555555");
    expect((await getAsset(avatar)).status).toBe(200);

    const appLogo =
      "logos/assets/app-logo/44444444-4444-4444-8444-444444444444/l.png";
    currentSession = null;
    expect((await getAsset(appLogo)).status).toBe(200);

    // The public kind may not live outside the public namespace.
    currentSession = session(TEAM);
    const misplaced = `${TEAM}/assets/app-logo/44444444-4444-4444-8444-444444444444/l.png`;
    expect((await getAsset(misplaced)).status).toBe(404);
  });

  test("uploads derive the namespace from the kind and reject unusable images", async () => {
    currentSession = session(TEAM);
    uploads.length = 0;

    const validPng = new Uint8Array(
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: "white" },
      })
        .png()
        .toBuffer(),
    );

    expect((await postAsset("logo", validPng)).status).toBe(200);
    expect(uploads[0]?.path[0]).toBe(TEAM);
    expect(uploads[0]?.path[1]).toBe("assets");
    expect(uploads[0]?.path[2]).toBe("logo");

    // A truncated body fails the real decoder.
    const truncated = validPng.subarray(0, Math.floor(validPng.length / 2));
    expect((await postAsset("logo", truncated)).status).toBe(400);

    // Unknown kinds are refused instead of inventing a namespace.
    expect((await postAsset("invoice", validPng)).status).toBe(400);
  });
});
