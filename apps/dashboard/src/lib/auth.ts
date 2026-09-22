import "server-only";

import { getAuthSession } from "@invoicewise/api/auth";
import { headers } from "next/headers";

export async function getSession() {
  return getAuthSession(await headers());
}
