import { AuthPage } from "@/components/auth-page";
import { ResetPasswordForm } from "@/components/reset-password-form";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Choose password | InvoiceWise" };

export default function ResetPasswordPage() {
  return (
    <AuthPage
      title="Choose a new password"
      description="Use at least eight characters."
    >
      <ResetPasswordForm />
    </AuthPage>
  );
}
