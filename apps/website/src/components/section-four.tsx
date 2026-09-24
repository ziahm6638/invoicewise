import deliveryImage from "public/app/delivery.png";
import { Check } from "./check";
import { CtaLink } from "./cta-link";
import { DynamicImage } from "./dynamic-image";

export function SectionFour() {
  return (
    <section className="flex justify-between space-y-12 lg:space-y-0 lg:space-x-8 flex-col lg:flex-row overflow-hidden mb-12 relative">
      <div className="border border-border md:basis-2/3 dark:bg-[#121212] p-10 flex justify-between md:space-x-8 md:flex-row flex-col group">
        <div className="flex flex-col md:basis-1/2">
          <h4 className="font-medium text-xl md:text-2xl mb-4">Delivery</h4>

          <p className="text-[#878787] md:mb-4 text-sm">
            Once an invoice is extracted and judged, InvoiceWise puts it where
            you need it. Connect Xero or QuickBooks for draft bills, or pull the
            data out however you work.
          </p>

          <div className="flex flex-col space-y-2 mt-8">
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Xero</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">QuickBooks</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">REST API</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">MCP for AI agents</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Webhooks</span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">CSV export</span>
            </div>
          </div>

          <div className="mt-10 md:absolute md:bottom-6">
            <CtaLink text="See where your data lands" />
          </div>
        </div>

        <div className="md:basis-1/2 mt-8 md:mt-0 flex items-center">
          <DynamicImage
            lightSrc={deliveryImage}
            darkSrc={deliveryImage}
            width={520}
            height={380}
            quality={90}
            className="object-contain"
            alt="InvoiceWise connected accounting and delivery settings"
          />
        </div>
      </div>

      <div className="border border-border basis-1/3 dark:bg-[#121212] p-10 flex flex-col relative group">
        <h4 className="font-medium text-xl md:text-2xl mb-4">
          Email-first ingestion (coming soon)
        </h4>
        <ul className="list-decimal list-inside text-[#878787] text-sm space-y-2 leading-relaxed">
          <li>Every workspace will get its own inbound address.</li>
          <li>
            Suppliers send straight there, or you forward what already lands in
            your inbox.
          </li>
          <li>
            PDFs and scans both work. The original stays linked to the extracted
            data.
          </li>
        </ul>

        <div className="flex flex-col space-y-2 mb-6 mt-8">
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">Dedicated mailbox (coming)</span>
          </div>
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">PDF and scanned invoices</span>
          </div>
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">
              No upload step once your mailbox is live
            </span>
          </div>
        </div>

        <div className="mt-auto md:absolute md:bottom-6">
          <CtaLink text="Never type an invoice again" />
        </div>
      </div>
    </section>
  );
}
