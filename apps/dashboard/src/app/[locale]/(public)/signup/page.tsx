import { AuthForm } from "@/components/auth-form";
import { AuthPage } from "@/components/auth-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Create account | InvoiceWise" };

export default function SignUpPage() {
  return (
    <AuthPage
      title="Create your workspace"
      description="Start turning incoming invoices into structured data."
    >
      <AuthForm mode="sign-up" />
    </AuthPage>
  );
}
