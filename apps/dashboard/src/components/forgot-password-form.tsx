"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { type FormEvent, useState } from "react";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await authClient.requestPasswordReset({
      email: String(form.get("email")),
      redirectTo: "/reset-password",
    });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not send the reset email");
      return;
    }

    setSent(true);
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {sent && (
        <p className="text-sm text-emerald-600">
          If that account exists, a reset link is on its way.
        </p>
      )}
      <Button className="w-full" type="submit" disabled={pending || sent}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
