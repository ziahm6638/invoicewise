import { mailboxLive } from "@/lib/mailbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@invoicewise/ui/accordion";
import { Button } from "@invoicewise/ui/button";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing",
  description: "InvoiceWise pricing",
};

export default function Page() {
  const live = mailboxLive();
  return (
    <div className="container">
      <div className="flex items-center flex-col text-center relative">
        <h1 className="mt-24 font-medium text-center text-5xl mb-4">
          Simple pricing, announced with early access
        </h1>
        <p className="text-md text-muted-foreground mb-12 max-w-2xl">
          InvoiceWise is in active development. Early access is free while we
          finish accounting delivery, and waitlist members hear the paid plans
          first.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 w-full max-w-5xl mt-8 text-left">
          <div className="flex flex-col p-8 border border-primary bg-background relative">
            <div className="absolute top-0 right-0 mr-4 mt-4 rounded-full text-[#878787] text-[9px] font-normal border px-2 py-1 font-mono">
              Early access
            </div>
            <h2 className="text-xl mb-2">Starter</h2>
            <div className="mt-4 flex items-baseline">
              <span className="text-[40px] font-medium tracking-tight">
                Free
              </span>
              <span className="ml-2 text-sm text-muted-foreground">
                while in development
              </span>
            </div>
            <p className="mt-4 text-[#878787] text-sm">
              For teams who want to try TypeSafe extraction and judgments on
              real invoices.
            </p>

            <div className="mt-8">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[#878787] font-mono">
                INCLUDING
              </h3>
              <ul className="mt-4 space-y-2">
                {[
                  live
                    ? "Dedicated inbound mailbox"
                    : "Dedicated inbound mailbox (coming)",
                  "TypeSafe extraction from PDFs and scans",
                  "Default judgment questions",
                  "Your own questions",
                  "Original document kept and linked",
                  "API, MCP, webhooks and CSV",
                ].map((item) => (
                  <li key={item} className="flex items-start">
                    <Check className="h-5 w-5 text-primary flex-shrink-0 mr-2" />
                    <span className="text-sm">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-8 border-t-[1px] border-border pt-8">
              <Link href="/#waitlist">
                <Button className="w-full h-12">Join the waitlist</Button>
              </Link>
            </div>
          </div>

          <div className="flex flex-col p-8 border bg-background">
            <h2 className="text-xl mb-2">Team</h2>
            <div className="mt-4 flex items-baseline">
              <span className="text-[28px] font-medium tracking-tight">
                Pricing to be announced
              </span>
            </div>
            <p className="mt-4 text-[#878787] text-sm">
              For teams that need automatic delivery into their accounting
              system and higher volumes.
            </p>

            <div className="mt-8">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[#878787] font-mono">
                INCLUDING
              </h3>
              <ul className="mt-4 space-y-2">
                {[
                  "Everything in Starter",
                  "Automatic delivery to Xero (coming)",
                  "Automatic delivery to QuickBooks (coming)",
                  "Higher invoice volumes",
                  "Priority support",
                ].map((item) => (
                  <li key={item} className="flex items-start">
                    <Check className="h-5 w-5 text-primary flex-shrink-0 mr-2" />
                    <span className="text-sm">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-8 border-t border-border pt-8">
              <a href="mailto:hello@invoicewise.uk">
                <Button variant="outline" className="w-full h-12">
                  Talk to us
                </Button>
              </a>
            </div>
          </div>
        </div>

        <div className="mt-4 flex w-full max-w-5xl items-center justify-between">
          <p className="mt-4 text-xs text-muted-foreground font-mono">
            No credit card required.
          </p>

          <p className="mt-4 text-xs text-muted-foreground font-mono hidden md:block">
            Need something specific?{" "}
            <a href="mailto:hello@invoicewise.uk" className="underline">
              contact us
            </a>
            .
          </p>
        </div>
      </div>

      <div className="container max-w-[800px] mt-32">
        <div className="text-center">
          <h4 className="text-4xl">Frequently asked questions</h4>
        </div>

        <Accordion type="single" collapsible className="w-full mt-10 mb-48">
          <AccordionItem value="item-1">
            <AccordionTrigger>What is InvoiceWise?</AccordionTrigger>
            <AccordionContent>
              Invoice middleware. Forward invoices to{" "}
              {live
                ? "your dedicated mailbox"
                : "a dedicated mailbox (coming soon)"}{" "}
              and get typed, structured data back, with the answers to your own
              questions attached. It sits between invoice receipt and the
              systems that need the data.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>
              Is accounting delivery live yet?
            </AccordionTrigger>
            <AccordionContent>
              Not yet. Automatic delivery to Xero and QuickBooks is in progress.
              Until it ships, invoices are available through the API, MCP,
              webhooks and CSV export, and the original documents stay stored
              with their extracted data.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>Do you store my invoices?</AccordionTrigger>
            <AccordionContent>
              Yes. We keep the original document alongside the extracted fields
              and a hash of the file, so every value can be traced back to its
              source. See our{" "}
              <Link href="/policy" className="underline">
                privacy policy
              </Link>{" "}
              for what we collect and why.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-4">
            <AccordionTrigger>How do I get access?</AccordionTrigger>
            <AccordionContent>
              Join the waitlist and we will email you when early access opens.
              If you would like to talk through your setup first, email{" "}
              <a href="mailto:hello@invoicewise.uk" className="underline">
                hello@invoicewise.uk
              </a>
              .
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-5">
            <AccordionTrigger>Can I cancel at any time?</AccordionTrigger>
            <AccordionContent>
              Yes. Early access is free, and once paid plans exist you can
              cancel at any time. There is nothing to cancel today.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}
