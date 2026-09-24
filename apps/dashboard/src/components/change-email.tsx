"use client";

import { useUserQuery } from "@/hooks/use-user";
import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@invoicewise/ui/card";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { type FormEvent, useState } from "react";

/**
 * The verified address only changes through Better Auth's own email-change
 * flow: the request needs a recent session and the new address must be
 * confirmed from the link sent to it. Completing the change ends every session,
 * so the account signs in again with the new address.
 */
export function ChangeEmail() {
  const { data: user } = useUserQuery();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [sentTo, setSentTo] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setSentTo(undefined);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const newEmail = String(form.get("email")).trim();
    const result = await authClient.changeEmail({
      newEmail,
      callbackURL: "/",
    });

    setPending(false);

    if (result.error) {
      setError(
        result.error.message ??
          "Could not start the email change. Sign in again and retry.",
      );
      return;
    }

    setSentTo(newEmail);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>
          Change the address that signs you in and receives account
          notifications. Connected invoice mailboxes are managed separately
          under Email settings.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="max-w-sm space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="email">New email address</Label>
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={user?.email ?? ""}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {sentTo && (
            <p className="text-sm text-emerald-600">
              Verification sent to {sentTo}. Open the link to finish the change;
              every session then signs out and you sign in with the new address.
            </p>
          )}

          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send verification link"}
          </Button>
        </form>
      </CardContent>

      <CardFooter className="text-sm text-muted-foreground">
        Current address: {user?.email}
      </CardFooter>
    </Card>
  );
}
