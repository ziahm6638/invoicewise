import { SourcesView } from "@/components/authorization-sources/sources-view";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Authorization sources | InvoiceWise",
};

export default function AuthorizationsPage() {
  return (
    <main className="max-w-[1100px] pt-4">
      <SourcesView />
    </main>
  );
}
