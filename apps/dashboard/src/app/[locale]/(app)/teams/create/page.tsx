import { DeleteAccountDialog } from "@/components/delete-account";
import { CreateTeamForm } from "@/components/forms/create-team-form";
import { getCountryCode, getCurrency } from "@invoicewise/location";
import { Icons } from "@invoicewise/ui/icons";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Create Team | InvoiceWise",
};

export default function CreateTeam() {
  const currency = getCurrency();
  const countryCode = getCountryCode();

  return (
    <>
      <header className="w-full absolute left-0 right-0 flex justify-between items-center">
        <div className="ml-5 mt-4 md:ml-10 md:mt-10">
          <Link href="/">
            <Icons.LogoSmall />
          </Link>
        </div>
      </header>

      <div className="flex min-h-screen justify-center items-center overflow-hidden p-6 md:p-0">
        <div className="relative z-20 m-auto flex w-full max-w-[400px] flex-col">
          <div className="text-center">
            <h1 className="text-lg mb-2 font-serif">Setup your team</h1>
            <p className="text-[#878787] text-sm mb-8">
              Add your company name, country and currency. We’ll use this to
              personalize your experience in InvoiceWise.
            </p>
          </div>

          <CreateTeamForm
            defaultCurrencyPromise={currency}
            defaultCountryCodePromise={countryCode}
          />

          {/* Account settings need a workspace, so someone with none can
              still delete their account from here. */}
          <p className="text-center text-sm text-[#878787] mt-8">
            Not staying?{" "}
            <DeleteAccountDialog>
              <button type="button" className="underline underline-offset-4">
                Delete your account
              </button>
            </DeleteAccountDialog>
          </p>
        </div>
      </div>
    </>
  );
}
