import { getPublicUrl } from "@/utils/environment";
import { getSessionCookie } from "better-auth/cookies";
import { createI18nMiddleware } from "next-international/middleware";
import { type NextRequest, NextResponse } from "next/server";

const I18nMiddleware = createI18nMiddleware({
  locales: ["en"],
  defaultLocale: "en",
  urlMappingStrategy: "rewrite",
});

export async function middleware(request: NextRequest) {
  const response = I18nMiddleware(request);
  const nextUrl = request.nextUrl;

  const pathnameLocale = nextUrl.pathname.split("/", 2)?.[1];

  // Remove the locale from the pathname
  const pathnameWithoutLocale = pathnameLocale
    ? nextUrl.pathname.slice(pathnameLocale.length + 1)
    : nextUrl.pathname;

  // Create a new URL without the locale in the pathname
  const newUrl = new URL(pathnameWithoutLocale || "/", request.url);

  const returnTo = `${newUrl.pathname}${nextUrl.search}`;

  const hasSessionCookie = Boolean(getSessionCookie(request));
  const isPublicAuthPage = [
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/verify-email",
  ].includes(newUrl.pathname);

  if (!hasSessionCookie && !isPublicAuthPage) {
    const url = getPublicUrl("/login");

    url.searchParams.set("return_to", returnTo);

    return NextResponse.redirect(url);
  }

  return response;
}

// Icons and the web manifest are public so the sign-in page, browser tabs and
// installed apps can load them without a session.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|icon-192.png|icon-512.png|manifest.webmanifest|api).*)",
  ],
};
