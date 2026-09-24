import { Button } from "@invoicewise/ui/button";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="flex flex-col items-center text-center">
        <p className="font-mono text-sm text-[#878787]">404</p>
        <h1 className="mt-4 text-4xl font-medium">
          We could not find that page.
        </h1>
        <p className="mt-4 text-[#878787] max-w-[420px]">
          The link may be out of date. Head back to the homepage or get in touch
          if you were expecting something here.
        </p>
        <div className="mt-8">
          <Link href="/">
            <Button
              variant="outline"
              className="border border-primary h-11 px-6"
            >
              Back to homepage
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
