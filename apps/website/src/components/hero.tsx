import { Button } from "@invoicewise/ui/button";
import Link from "next/link";
import { HeroImage } from "./hero-image";
import { WordAnimation } from "./word-animation";

export function Hero() {
  return (
    <section className="mt-[60px] lg:mt-[180px] min-h-[530px] relative lg:h-[calc(100vh-300px)]">
      <div className="flex flex-col">
        <Link href="/#how-it-works">
          <Button
            variant="outline"
            className="rounded-full border-border flex space-x-2 items-center"
          >
            <span className="font-mono text-xs">Invoice middleware</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={12}
              height={12}
              fill="none"
            >
              <path
                fill="currentColor"
                d="M8.783 6.667H.667V5.333h8.116L5.05 1.6 6 .667 11.333 6 6 11.333l-.95-.933 3.733-3.733Z"
              />
            </svg>
          </Button>
        </Link>

        <h2 className="mt-6 md:mt-10 max-w-[640px] text-[#878787] leading-tight text-[24px] md:text-[36px] font-medium">
          Forward invoices to a dedicated mailbox and get typed, structured data
          back for <WordAnimation />
        </h2>

        <div className="mt-8 md:mt-10">
          <div className="flex items-center space-x-4">
            <Link href="/#waitlist">
              <Button
                variant="outline"
                className="border-transparent h-11 px-6 dark:bg-[#1D1D1D] bg-[#F2F1EF]"
              >
                Join the waitlist
              </Button>
            </Link>

            <a href="https://app.invoicewise.uk">
              <Button className="h-11 px-5">Sign in</Button>
            </a>
          </div>
        </div>

        <p className="text-xs text-[#707070] mt-4 font-mono">
          Early access is opening soon. No credit card required.
        </p>
      </div>

      <HeroImage />
    </section>
  );
}
