import { Wordmark } from "@/components/brand";
import { SubscribeInput } from "@/components/subscribe-input";
import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t-[1px] border-border px-4 md:px-6 pt-10 md:pt-16 bg-[#fff] dark:bg-[#0C0C0C] overflow-hidden md:max-h-[820px]">
      <div className="container">
        <div className="flex justify-between items-center border-border border-b-[1px] pb-10 md:pb-16 mb-12">
          <Link href="/">
            <Wordmark />
            <span className="sr-only">InvoiceWise</span>
          </Link>

          <span className="font-normal md:text-2xl text-right">
            Invoices in. Structured data out.
          </span>
        </div>

        <div className="flex flex-col md:flex-row w-full">
          <div className="flex flex-col space-y-8 md:space-y-0 md:flex-row md:w-6/12 justify-between leading-8">
            <div>
              <span className="font-medium">Product</span>
              <ul>
                <li className="transition-colors text-[#878787]">
                  <Link href="/#how-it-works">How it works</Link>
                </li>
                <li className="transition-colors text-[#878787]">
                  <Link href="/pricing">Pricing</Link>
                </li>
                <li className="transition-colors text-[#878787]">
                  <a href="https://app.invoicewise.uk">Sign in</a>
                </li>
              </ul>
            </div>

            <div>
              <span>Legal</span>
              <ul>
                <li className="transition-colors text-[#878787]">
                  <Link href="/policy">Privacy policy</Link>
                </li>
                <li className="transition-colors text-[#878787]">
                  <Link href="/terms">Terms and Conditions</Link>
                </li>
                <li className="transition-colors text-[#878787]">
                  <a href="mailto:hello@invoicewise.uk">Contact</a>
                </li>
              </ul>
            </div>
          </div>

          <div className="md:w-6/12 flex mt-8 md:mt-0 md:justify-end">
            <div className="flex md:items-end flex-col">
              <p className="text-sm text-[#878787] mb-4 max-w-[360px] md:text-right">
                Join the waitlist and we will email you when early access opens.
              </p>
              <div className="mb-8">
                <SubscribeInput />
              </div>
              <p className="text-xs text-[#878787]">
                InvoiceWise is a Sortx Software Ltd product.
              </p>
            </div>
          </div>
        </div>
      </div>

      <h5 className="dark:text-[#161616] text-[#F4F4F3] text-[260px] md:text-[500px] leading-none text-center pointer-events-none">
        invoicewise
      </h5>
    </footer>
  );
}
