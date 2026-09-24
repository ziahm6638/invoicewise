"use client";

import {
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Without a `twoFactorPage` the plugin never navigates: the sign-in form reads
// `twoFactorRedirect` from the response and asks for the second factor itself.
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});
