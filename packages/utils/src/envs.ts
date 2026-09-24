export function getAppUrl() {
  // A configured application origin wins: invitation and account links must
  // point at the deployment the customer is actually using, not at the
  // inherited Midday host.
  const configuredAppUrl = (
    process.env.NEXT_PUBLIC_URL ?? process.env.APP_URL
  )?.trim();

  if (configuredAppUrl) {
    return configuredAppUrl.replace(/\/+$/, "");
  }

  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  ) {
    return "https://app.midday.ai";
  }

  if (process.env.VERCEL_ENV === "preview") {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3001";
}

export function getEmailUrl() {
  if (process.env.NODE_ENV === "development") {
    return "http://localhost:3000";
  }

  return "https://midday.ai";
}

export function getWebsiteUrl() {
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.NODE_ENV === "production"
  ) {
    return "https://midday.ai";
  }

  if (process.env.VERCEL_ENV === "preview") {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}

export function getCdnUrl() {
  return "https://cdn.midday.ai";
}
