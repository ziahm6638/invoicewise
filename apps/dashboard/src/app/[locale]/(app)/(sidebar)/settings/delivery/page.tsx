import { DeliveryRules } from "@/components/delivery-rules";
import { prefetch, trpc } from "@/trpc/server";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Delivery rules | InvoiceWise",
};

// Every member can read the rules; owners and admins change them.
export default function DeliveryRulesSettingsPage() {
  prefetch(trpc.deliveryRules.get.queryOptions());

  return <DeliveryRules />;
}
