import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "InvoiceWise",
    short_name: "InvoiceWise",
    description:
      "Turn incoming invoices into structured data ready for your accounting systems.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0c0c0c",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
