"use client";

import questionsImage from "public/app/questions.png";
import { Check } from "./check";
import { CtaLink } from "./cta-link";
import { DynamicImage } from "./dynamic-image";

export function SectionThree() {
  return (
    <section className="relative mb-12 group">
      <div className="border border-border container dark:bg-[#121212] p-8 md:p-10 md:pb-0 overflow-hidden">
        <div className="flex flex-col md:space-x-12 md:flex-row">
          <div className="xl:mt-6 md:max-w-[40%] md:mr-8 md:mb-8">
            <h3 className="font-medium text-xl md:text-2xl mb-4">
              Your questions, answered
            </h3>

            <p className="text-[#878787] md:mb-4 text-sm">
              Ask the questions that matter to your business in plain language.
              InvoiceWise runs them on every invoice automatically, with
              confidence scores attached.
            </p>

            <div className="flex flex-col space-y-2 mt-8">
              <div className="flex space-x-2 text-sm">
                <Check />
                <span className="text-primary">
                  Is this a duplicate of a previous invoice?
                </span>
              </div>
              <div className="flex space-x-2 text-sm">
                <Check />
                <span className="text-primary">
                  Is the VAT calculation correct?
                </span>
              </div>
              <div className="flex space-x-2 text-sm">
                <Check />
                <span className="text-primary">
                  Does this supplier match known suppliers?
                </span>
              </div>
              <div className="flex space-x-2 text-sm">
                <Check />
                <span className="text-primary">
                  Are the bank details consistent with past invoices?
                </span>
              </div>
              <div className="flex space-x-2 text-sm">
                <Check />
                <span className="text-primary">
                  Your own thresholds and categories
                </span>
              </div>
            </div>

            <div className="mt-10 md:absolute md:bottom-6">
              <CtaLink text="Ask your own questions" />
            </div>
          </div>

          <div className="relative mt-8 md:mt-0 flex-1">
            <div className="scale-90 md:scale-100 origin-bottom">
              <DynamicImage
                lightSrc={questionsImage}
                darkSrc={questionsImage}
                height={500}
                quality={90}
                className="-mb-[1px] object-contain object-bottom"
                alt="InvoiceWise judgments and questions on an invoice"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
