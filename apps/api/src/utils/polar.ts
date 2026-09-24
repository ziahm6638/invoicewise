import { Polar } from "@polar-sh/sdk";

export const api = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN!,
  server: process.env.POLAR_ENVIRONMENT as "production" | "sandbox",
  // Optional base-URL override: unset in production (the SDK maps `server`),
  // pointed at a loopback stub by the local verification run.
  serverURL: process.env.POLAR_SERVER_URL || undefined,
});
