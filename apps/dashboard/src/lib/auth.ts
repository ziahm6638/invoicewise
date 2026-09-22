import "server-only";

import { getAuthSession } from "@midday/api/auth";
import { headers } from "next/headers";

export async function getSession() {
  return getAuthSession(await headers());
}
