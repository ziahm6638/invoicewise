import { AuthPage } from "@/components/auth-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Verify email | InvoiceWise" };

export default function VerifyEmailPage() {
  return (
    <AuthPage
      title="Check your email"
      description="Open the verification link to finish creating your workspace."
    >
      <p className="text-center text-sm text-muted-foreground">
        You can close this page after verifying your address.
      </p>
    </AuthPage>
  );
}
