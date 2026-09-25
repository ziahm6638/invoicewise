import { DataExport, RetentionSchedule } from "@/components/data-export";
import { prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Data | InvoiceWise",
};

export default function DataSettingsPage() {
  prefetch(trpc.data.retentionPolicy.queryOptions());

  return (
    <div className="space-y-12">
      <DataExport />
      <RetentionSchedule />
    </div>
  );
}
