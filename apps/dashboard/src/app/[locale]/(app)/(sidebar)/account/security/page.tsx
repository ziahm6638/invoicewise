import { ChangePassword } from "@/components/change-password";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security | InvoiceWise",
};

export default function Security() {
  return <ChangePassword />;
}
