"use client";

import { TwoFactorChallenge } from "@/components/two-factor-challenge";
import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string>();
  const [secondFactor, setSecondFactor] = useState(false);
  const isSignUp = mode === "sign-up";

  const rawReturnTo = searchParams.get("return_to");
  const returnTo =
    rawReturnTo?.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setUnverifiedEmail(undefined);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const result = isSignUp
      ? await authClient.signUp.email({
          email,
          password,
          name: String(form.get("name")),
          callbackURL: returnTo,
        })
      : await authClient.signIn.email({ email, password });

    setPending(false);

    if (result.error) {
      const failure =
        result.error.status === 429
          ? "Too many attempts. Wait a moment and try again."
          : (result.error.message ?? "Authentication failed");
      setError(failure);
      // A blocked sign-in is the moment a lost verification link matters, so
      // offer the retry here instead of leaving the account stranded.
      if (!isSignUp && /not verified/i.test(failure)) {
        setUnverifiedEmail(email);
      }
      return;
    }

    if (isSignUp) {
      setMessage("Check your email to verify your account.");
      return;
    }

    // The password was right, but the account needs its second factor before
    // a session is issued.
    if (
      result.data &&
      "twoFactorRedirect" in result.data &&
      result.data.twoFactorRedirect
    ) {
      setSecondFactor(true);
      return;
    }

    window.location.assign(returnTo);
  }

  async function resendVerification() {
    if (!unverifiedEmail) return;

    setError(undefined);
    setPending(true);
    const result = await authClient.sendVerificationEmail({
      email: unverifiedEmail,
      callbackURL: returnTo,
    });
    setPending(false);

    if (result.error) {
      setError(result.error.message ?? "Could not send the verification email");
      return;
    }

    setMessage(`Verification sent to ${unverifiedEmail}.`);
    setUnverifiedEmail(undefined);
  }

  if (secondFactor) {
    return (
      <TwoFactorChallenge
        onVerified={() => window.location.assign(returnTo)}
        onCancel={() => setSecondFactor(false)}
      />
    );
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      {isSignUp && (
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          {!isSignUp && (
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground underline"
            >
              Forgot password?
            </Link>
          )}
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          maxLength={128}
          autoComplete={isSignUp ? "new-password" : "current-password"}
          required
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-emerald-600">{message}</p>}
      {unverifiedEmail && (
        <Button
          className="w-full"
          type="button"
          variant="outline"
          disabled={pending}
          onClick={resendVerification}
        >
          Resend verification email
        </Button>
      )}

      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {isSignUp ? "Already have an account?" : "New to InvoiceWise?"}{" "}
        <Link href={isSignUp ? "/login" : "/signup"} className="underline">
          {isSignUp ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
