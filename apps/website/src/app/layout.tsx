import { Footer } from "@/components/footer";
import { FooterCTA } from "@/components/footer-cta";
import { Header } from "@/components/header";
import { ThemeProvider } from "@/components/theme-provider";
import { mailboxLive } from "@/lib/mailbox";
import "@/styles/globals.css";
import "@invoicewise/ui/globals.css";
import { cn } from "@invoicewise/ui/cn";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { baseUrl } from "./sitemap";

const title = "InvoiceWise | Invoice middleware";
const description = `Forward invoices to ${mailboxLive() ? "your dedicated mailbox" : "a dedicated mailbox (coming soon)"}. InvoiceWise extracts the fields with TypeSafe, answers your own questions automatically, and delivers clean data to Xero (coming), QuickBooks (coming), your API, MCP, webhooks or CSV.`;

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title: {
    default: title,
    template: "%s | InvoiceWise",
  },
  description,
  openGraph: {
    title,
    description,
    url: baseUrl,
    siteName: "InvoiceWise",
    locale: "en_GB",
    type: "website",
    images: [
      {
        url: "/app/og.png",
        width: 1200,
        height: 630,
        alt: "InvoiceWise",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/app/og.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)" },
    { media: "(prefers-color-scheme: dark)" },
  ],
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <body
        className={cn(
          `${GeistSans.variable} ${GeistMono.variable}`,
          "bg-[#fbfbfb] dark:bg-[#0C0C0C] overflow-x-hidden font-sans antialiased",
        )}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Header />
          <main className="container mx-auto px-4 overflow-hidden md:overflow-visible">
            {children}
          </main>
          <FooterCTA mailboxLive={mailboxLive()} />
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
