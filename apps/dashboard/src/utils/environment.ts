export function getUrl() {
  if (process.env.NEXT_PUBLIC_URL) {
    return process.env.NEXT_PUBLIC_URL;
  }

  if (process.env.VERCEL_TARGET_ENV === "preview") {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3001";
}

/**
 * Resolves a same-origin path against the configured public dashboard origin.
 *
 * Server-side redirects must use this, never `request.url`: behind the
 * production proxy the request origin is the container's internal
 * `https://localhost:3000`, not the host the browser is on.
 */
export function getPublicUrl(path: string) {
  return new URL(path, getUrl());
}
