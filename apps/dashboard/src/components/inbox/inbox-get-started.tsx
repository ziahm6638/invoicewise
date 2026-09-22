"use client";

import { ConnectGmail } from "@/components/inbox/connect-gmail";
import { useUserQuery } from "@/hooks/use-user";
import { getInboxEmail } from "@invoicewise/inbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@invoicewise/ui/accordion";
import { useRouter } from "next/navigation";
import { CopyInput } from "../copy-input";
import { UploadZone } from "./inbox-upload-zone";

export function InboxGetStarted() {
  const { data: user } = useUserQuery();
  const router = useRouter();

  const handleUpload = () => {
    router.push("/invoices?connected=true", { scroll: false });
  };

  return (
    <UploadZone onUploadComplete={handleUpload}>
      <div className="h-[calc(100vh-150px)] flex items-center justify-center">
        <div className="relative z-20 m-auto flex w-full max-w-[380px] flex-col">
          <div className="flex w-full flex-col relative">
            <div className="pb-4 text-center">
              <h2 className="font-medium text-lg">
                Bring in your first invoice
              </h2>
              <p className="pb-6 text-sm text-[#878787]">
                Connect Gmail to collect invoices automatically. InvoiceWise
                will extract the fields, run your checks, and keep the source
                document beside the result.
              </p>
            </div>

            <div className="pointer-events-auto flex flex-col space-y-4">
              <ConnectGmail />

              {user?.team?.inboxId && (
                <Accordion
                  type="single"
                  collapsible
                  className="border-t-[1px] pt-2 mt-6"
                >
                  <AccordionItem value="item-1" className="border-0">
                    <AccordionTrigger className="justify-center space-x-2 flex text-sm">
                      <span>More options</span>
                    </AccordionTrigger>
                    <AccordionContent className="mt-4">
                      <div className="flex flex-col space-y-4">
                        <CopyInput value={getInboxEmail(user.team.inboxId)} />
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </div>

            <div className="text-center mt-8">
              <p className="text-xs text-[#878787]">
                Or drag and drop a PDF here to process it now.
              </p>
            </div>
          </div>
        </div>
      </div>
    </UploadZone>
  );
}
