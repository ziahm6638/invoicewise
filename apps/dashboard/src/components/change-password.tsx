"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { type FormEvent, useState } from "react";

export function ChangePassword() {
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setMessage(undefined);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const result = await authClient.changePassword({
      currentPassword: String(form.get("currentPassword")),
      newPassword: String(form.get("newPassword")),
      revokeOtherSessions: true,
    });

    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not update your password");
      return;
    }

    event.currentTarget.reset();
    setMessage("Password updated.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Changing your password signs out your other sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="max-w-sm space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {message && <p className="text-sm text-emerald-600">{message}</p>}
          <Button type="submit" disabled={pending}>
            {pending ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
