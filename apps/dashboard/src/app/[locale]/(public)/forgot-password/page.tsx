import { AuthPage } from "@/components/auth-page";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Reset password | InvoiceWise" };

export default function ForgotPasswordPage() {
  return (
    <AuthPage
      title="Reset your password"
      description="We’ll email you a secure reset link."
    >
      <ForgotPasswordForm />
    </AuthPage>
  );
}
