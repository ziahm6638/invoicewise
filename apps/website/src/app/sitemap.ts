import type { MetadataRoute } from "next";

export const baseUrl = "https://invoicewise.uk";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date().toISOString().split("T")[0];

  return ["", "/pricing", "/policy", "/terms"].map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified,
  }));
}
