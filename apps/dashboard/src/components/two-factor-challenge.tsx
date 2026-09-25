"use client";

import { authClient } from "@/lib/auth-client";
import { Button } from "@invoicewise/ui/button";
import { Input } from "@invoicewise/ui/input";
import { Label } from "@invoicewise/ui/label";
import { type FormEvent, useState } from "react";

/**
 * Second sign-in step for an account with two-factor authentication. The
 * password step left a short-lived challenge cookie; a code from the
 * authenticator app or one unused recovery code completes it.
 */
export function TwoFactorChallenge({
  onVerified,
  onCancel,
}: {
  onVerified: () => void;
  onCancel: () => void;
}) {
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);

    const code = String(new FormData(event.currentTarget).get("code")).trim();
    const result = useRecoveryCode
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });

    setPending(false);

    if (result.error) {
      setError(
        result.error.status === 429
          ? "Too many attempts. Wait a moment, then sign in again."
          : useRecoveryCode
            ? "That recovery code is not valid or has already been used."
            : "That code is not valid. Check your authenticator app and try again.",
      );
      return;
    }

    onVerified();
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor="code">
          {useRecoveryCode ? "Recovery code" : "Authentication code"}
        </Label>
        <p className="text-sm text-muted-foreground">
          {useRecoveryCode
            ? "Enter one of the recovery codes you saved when you turned on two-factor authentication. Each code works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
        <Input
          key={useRecoveryCode ? "recovery" : "totp"}
          id="code"
          name="code"
          autoComplete="one-time-code"
          inputMode={useRecoveryCode ? "text" : "numeric"}
          pattern={useRecoveryCode ? undefined : "[0-9]{6}"}
          maxLength={useRecoveryCode ? 32 : 6}
          autoFocus
          required
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button className="w-full" type="submit" disabled={pending}>
        {pending ? "Verifying…" : "Verify"}
      </Button>

      <div className="flex justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={() => {
            setError(undefined);
            setUseRecoveryCode((value) => !value);
          }}
        >
          {useRecoveryCode ? "Use authenticator app" : "Use a recovery code"}
        </button>
        <button
          type="button"
          className="text-muted-foreground underline"
          onClick={onCancel}
        >
          Back
        </button>
      </div>
    </form>
  );
}
