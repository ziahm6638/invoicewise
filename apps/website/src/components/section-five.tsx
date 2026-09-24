import extractionLight from "public/app/extracted-fields.png";
import { Check } from "./check";
import { CtaLink } from "./cta-link";
import { DynamicImage } from "./dynamic-image";

export function SectionFive() {
  return (
    <section className="flex justify-between space-y-12 lg:space-y-0 lg:space-x-8 flex-col lg:flex-row overflow-hidden mb-12">
      <div className="border border-border lg:basis-2/3 dark:bg-[#121212] p-10 flex lg:space-x-8 lg:flex-row flex-col-reverse lg:items-start group">
        <DynamicImage
          lightSrc={extractionLight}
          darkSrc={extractionLight}
          quality={90}
          alt="An invoice detail with its original document and extracted fields"
          className="mt-8 lg:mt-0 basis-1/2 object-contain max-w-[70%] sm:max-w-[50%] md:max-w-[45%]"
        />

        <div className="flex flex-col basis-1/2 relative h-full">
          <h4 className="font-medium text-xl md:text-2xl mb-4">
            The original, kept
          </h4>

          <p className="text-[#878787] mb-4 text-sm">
            Every invoice is stored with its source document and a hash of the
            original, so the extracted fields always point back to the evidence.
          </p>

          <p className="text-[#878787] text-sm">
            Nothing is overwritten. If a value looks wrong, you can see exactly
            where it came from.
          </p>

          <div className="flex flex-col space-y-2 h-full mt-8">
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">
                Original PDF or image retained
              </span>
            </div>
            <div className="flex space-x-2 text-sm">
              <Check />
              <span className="text-primary">Document hash for provenance</span>
            </div>

            <div className="mt-10 md:absolute md:bottom-0 md:left-0">
              <CtaLink text="Keep the whole trail" />
            </div>
          </div>
        </div>
      </div>

      <div className="border border-border basis-1/3 dark:bg-[#121212] p-10 flex flex-col group">
        <h4 className="font-medium text-xl md:text-2xl mb-4">
          Structured output
        </h4>
        <p className="text-[#878787] text-sm mb-8">
          Pull invoices as clean, typed rows over the API or MCP, push them with
          webhooks, or export a period to CSV. The data is ready for whatever
          comes next, without a formatting pass first.
        </p>

        <div className="mt-auto flex flex-col space-y-2">
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">Typed fields and line items</span>
          </div>
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">
              Judgments returned with each record
            </span>
          </div>
          <div className="flex space-x-2 text-sm">
            <Check />
            <span className="text-primary">CSV built for accountants</span>
          </div>
        </div>

        <div className="mt-8">
          <CtaLink text="Connect your tools" />
        </div>
      </div>
    </section>
  );
}
