import extractionLight from "public/app/extraction.png";
import { Check } from "./check";
import { CtaLink } from "./cta-link";
import { DynamicImage } from "./dynamic-image";

export function SectionTwo() {
  return (
    <section className="border border-border container dark:bg-[#121212] lg:pb-0 overflow-hidden mb-12 group">
      <div className="flex flex-col lg:space-x-12 lg:flex-row">
        <DynamicImage
          lightSrc={extractionLight}
          darkSrc={extractionLight}
          height={446}
          width={836}
          className="-mb-[1px] object-contain lg:w-1/2"
          alt="Extracted invoice fields in the InvoiceWise app"
          quality={90}
        />

        <div className="xl:mt-6 lg:max-w-[40%] md:ml-8 md:mb-8 flex flex-col justify-center p-8 md:pl-0 relative">
          <h3 className="font-medium text-xl md:text-2xl mb-4">
            Automatic extraction
          </h3>

          <p className="text-[#878787] mb-8 lg:mb-4 text-sm">
            Upload an invoice, or forward one to your dedicated mailbox (coming
            soon), and InvoiceWise reads the supplier, amounts, dates, VAT, line
            items and bank details straight from the PDF or scan. No templates,
            no manual entry, nothing to re-type.
          </p>

          <div className="flex flex-col space-y-2">
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Supplier and invoice number</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Amounts, VAT and currency</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Line items</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Bank and payment details</span>
            </div>
          </div>

          <div className="absolute bottom-0 right-0">
            <CtaLink text="Try it on a real invoice" />
          </div>
        </div>
      </div>
    </section>
  );
}
