import "@/styles/globals.css";
import { cn } from "@invoicewise/ui/cn";
import "@invoicewise/ui/globals.css";
import { Provider as Analytics } from "@invoicewise/events/client";
import { Toaster } from "@invoicewise/ui/toaster";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { Lora } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import type { ReactElement } from "react";
import { Providers } from "./providers";

export const metadata: Metadata = {
  metadataBase: new URL("https://invoicewise.uk"),
  title: "InvoiceWise",
  description:
    "Turn incoming invoices into structured data ready for your accounting systems.",
  twitter: {
    card: "summary_large_image",
    title: "InvoiceWise",
    description:
      "Turn incoming invoices into structured data ready for your accounting systems.",
    images: ["https://invoicewise.uk/og.png"],
  },
  openGraph: {
    title: "InvoiceWise",
    description:
      "Turn incoming invoices into structured data ready for your accounting systems.",
    url: "https://invoicewise.uk",
    siteName: "InvoiceWise",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "https://invoicewise.uk/og.png",
        width: 1200,
        height: 630,
        alt: "InvoiceWise",
      },
    ],
  },
};

const lora = Lora({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
});

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default async function Layout({
  children,
  params,
}: {
  children: ReactElement;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={cn(
          `${GeistSans.variable} ${GeistMono.variable} ${lora.variable} font-sans`,
          "whitespace-pre-line overscroll-none antialiased",
        )}
      >
        <NuqsAdapter>
          <Providers locale={locale}>{children}</Providers>
          <Toaster />
          <Analytics />
        </NuqsAdapter>
      </body>
    </html>
  );
}
