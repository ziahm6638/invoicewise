import { resend } from "@api/services/resend";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db, primaryDb } from "@midday/db/client";
import { createTeam } from "@midday/db/queries/teams";
import {
  authAccounts,
  authSessions,
  authVerifications,
  teams,
  userInvites,
  users,
  usersOnTeam,
} from "@midday/db/schema";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { bearer, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

const baseURL =
  process.env.BETTER_AUTH_URL ??
  process.env.NEXT_PUBLIC_URL ??
  "http://localhost:3001";

const localAuthSecret =
  "invoicewise-local-development-auth-secret-change-in-production";
const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : localAuthSecret);
const cookieDomain = process.env.BETTER_AUTH_COOKIE_DOMAIN;

if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is required in production");
}

async function sendAuthEmail({
  to,
  subject,
  url,
}: {
  to: string;
  subject: string;
  url: string;
}) {
  if (
    !process.env.RESEND_API_KEY ||
    process.env.RESEND_API_KEY === "re_local_development"
  ) {
    console.info(`[auth-email] ${subject} for ${to}: ${url}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: process.env.AUTH_EMAIL_FROM ?? "InvoiceWise <auth@invoicewise.uk>",
    to,
    subject,
    text: `${subject}: ${url}`,
    html: `<p><a href="${url.replaceAll("&", "&amp;")}">${subject}</a></p>`,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export const auth = betterAuth({
  appName: "InvoiceWise",
  baseURL,
  secret: authSecret,
  trustedOrigins: [
    baseURL,
    ...(process.env.ALLOWED_API_ORIGINS?.split(",").filter(Boolean) ?? []),
  ],
  database: drizzleAdapter(primaryDb, {
    provider: "pg",
    schema: {
      user: users,
      session: authSessions,
      account: authAccounts,
      verification: authVerifications,
      organization: teams,
      member: usersOnTeam,
      invitation: userInvites,
    },
  }),
  advanced: {
    database: {
      generateId: "uuid",
    },
    crossSubDomainCookies: cookieDomain
      ? { enabled: true, domain: cookieDomain }
      : undefined,
  },
  user: {
    fields: {
      name: "fullName",
      image: "avatarUrl",
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: (password) => bcrypt.hash(password, 12),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
    async sendResetPassword({ user, url }) {
      await sendAuthEmail({
        to: user.email,
        subject: "Reset your InvoiceWise password",
        url,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      await sendAuthEmail({
        to: user.email,
        subject: "Verify your InvoiceWise email",
        url,
      });
    },
  },
  databaseHooks: {
    user: {
      create: {
        async after(user) {
          await createTeam(db, {
            name: `${user.name}'s workspace`,
            userId: user.id,
            email: user.email,
            switchTeam: true,
          });
        },
      },
    },
    session: {
      create: {
        async before(session) {
          const [user] = await primaryDb
            .select({ teamId: users.teamId })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);

          return {
            data: {
              ...session,
              activeOrganizationId: user?.teamId ?? null,
            },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      requireEmailVerificationOnInvitation: true,
      schema: {
        organization: {
          fields: {
            logo: "logoUrl",
          },
        },
        member: {
          fields: {
            organizationId: "teamId",
          },
        },
        invitation: {
          fields: {
            organizationId: "teamId",
            inviterId: "invitedBy",
          },
        },
      },
      async sendInvitationEmail({ id, email, organization }) {
        await sendAuthEmail({
          to: email,
          subject: `Join ${organization.name} on InvoiceWise`,
          url: `${baseURL}/teams?invitationId=${id}`,
        });
      },
    }),
    bearer({ requireSignature: true }),
  ],
});

export type Session = {
  user: {
    id: string;
    email?: string;
    full_name?: string;
  };
  teamId: string | null;
  oauth?: {
    applicationId: string;
    clientId?: string | null;
    applicationName?: string | null;
  };
};

export async function getAuthSession(
  requestHeaders: Headers,
): Promise<Session | null> {
  const sessionHeaders = new Headers(requestHeaders);

  if (sessionHeaders.has("authorization")) {
    sessionHeaders.delete("cookie");
  }

  const result = await auth.api.getSession({ headers: sessionHeaders });

  if (!result) {
    return null;
  }

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      full_name: result.user.name,
    },
    teamId: result.session.activeOrganizationId ?? null,
  };
}
