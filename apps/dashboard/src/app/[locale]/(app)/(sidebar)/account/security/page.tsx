import { ActiveSessions } from "@/components/active-sessions";
import { ChangePassword } from "@/components/change-password";
import { TwoFactorSettings } from "@/components/two-factor-settings";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security | InvoiceWise",
};

export default function Security() {
  return (
    <div className="space-y-12">
      <ChangePassword />
      <TwoFactorSettings />
      <ActiveSessions />
    </div>
  );
}
