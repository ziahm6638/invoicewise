import { AuthForm } from "@/components/auth-form";
import { AuthPage } from "@/components/auth-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in | InvoiceWise" };

export default function LoginPage() {
  return (
    <AuthPage
      title="Welcome back"
      description="Sign in to your InvoiceWise workspace."
    >
      <AuthForm mode="sign-in" />
    </AuthPage>
  );
}
