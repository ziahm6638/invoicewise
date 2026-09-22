"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token");
  const [error, setError] = useState<string>();
  const [complete, setComplete] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;

    setError(undefined);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const result = await authClient.resetPassword({
      newPassword: String(form.get("password")),
      token,
    });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not reset your password");
      return;
    }

    setComplete(true);
  }

  if (!token) {
    return (
      <p className="text-sm text-destructive">This reset link is invalid.</p>
    );
  }

  if (complete) {
    return (
      <p className="text-sm">
        Password updated.{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    );
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          maxLength={128}
          autoComplete="new-password"
          required
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
