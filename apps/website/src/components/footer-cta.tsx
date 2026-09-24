"use client";

import { Button } from "@invoicewise/ui/button";
import Link from "next/link";

export function FooterCTA() {
  return (
    <div className="border border-border md:container text-center px-10 py-14 mx-4 md:mx-auto md:px-24 md:py-20 mb-32 mt-24 flex items-center flex-col bg-[#F2F1EF] dark:bg-[#121212]">
      <span className="text-5xl md:text-7xl font-medium text-primary dark:text-white">
        Invoices in. Structured data out.
      </span>
      <p className="text-[#878787] mt-6 max-w-[560px]">
        Forward invoices to your mailbox and let InvoiceWise extract, judge and
        deliver them. No manual entry, no templates, no re-typing.
      </p>

      <div className="mt-10 md:mb-8">
        <div className="flex items-center space-x-4">
          <a href="mailto:hello@invoicewise.uk">
            <Button
              variant="outline"
              className="border border-primary h-12 px-6 dark:border-white border-black text-primary hidden md:block"
            >
              Talk to us
            </Button>
          </a>

          <a href="https://app.invoicewise.uk">
            <Button className="h-12 px-5 bg-black text-white dark:bg-white dark:text-black hover:bg-black/80 dark:hover:bg-white/80">
              Sign in
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}
