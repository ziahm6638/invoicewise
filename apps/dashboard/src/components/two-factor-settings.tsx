"use client";

import { authClient } from "@/lib/auth-client";
import { Badge } from "@invoicewise/ui/badge";
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
import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";

type Step =
  | { kind: "idle" }
  | { kind: "confirm-password"; action: PasswordAction }
  | { kind: "scan"; totpURI: string; backupCodes: string[] }
  | { kind: "codes"; backupCodes: string[] };

type PasswordAction = "enable" | "disable" | "regenerate";

const PASSWORD_PROMPTS: Record<PasswordAction, string> = {
  enable: "Turn on",
  disable: "Turn off",
  regenerate: "Generate new codes",
};

/** Better Auth errors worth showing verbatim; anything else gets a generic line. */
function describeError(error: { status?: number; message?: string }) {
  if (error.status === 429) {
    return "Too many attempts. Wait a moment and try again.";
  }

  if (error.status === 403) {
    return "For your security, sign out and sign in again before changing two-factor authentication.";
  }

  return error.message ?? "Something went wrong. Try again.";
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  function download() {
    const blob = new Blob(
      [
        `InvoiceWise recovery codes\nEach code signs you in once if you lose your authenticator.\n\n${codes.join("\n")}\n`,
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "invoicewise-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Save these recovery codes somewhere safe. Each one signs you in once if
        you lose your authenticator app. They will not be shown again.
      </p>
      <ul className="grid max-w-sm grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigator.clipboard.writeText(codes.join("\n"))}
        >
          Copy
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}

/**
 * Authenticator-app second factor. Enrollment, turning it off and replacing
 * the recovery codes each need the account password and a recent sign-in
 * (enforced by the identity service); the secret and codes are shown once and
 * never stored in the browser.
 */
export function TwoFactorSettings() {
  const { data: session, refetch } = authClient.useSession();
  const enabled = Boolean(session?.user?.twoFactorEnabled);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [qrCode, setQrCode] = useState<string>();

  const totpURI = step.kind === "scan" ? step.totpURI : undefined;

  useEffect(() => {
    if (!totpURI) {
      setQrCode(undefined);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(totpURI, { margin: 1, width: 192 }).then((url) => {
      if (!cancelled) {
        setQrCode(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [totpURI]);

  function reset() {
    setError(undefined);
    setStep({ kind: "idle" });
  }

  async function confirmPassword(
    event: FormEvent<HTMLFormElement>,
    action: PasswordAction,
  ) {
    event.preventDefault();
    setError(undefined);
    setPending(true);

    const password = String(new FormData(event.currentTarget).get("password"));

    if (action === "enable") {
      const result = await authClient.twoFactor.enable({ password });
      setPending(false);

      if (result.error || result.data?.method !== "totp") {
        setError(describeError(result.error ?? {}));
        return;
      }

      setStep({
        kind: "scan",
        totpURI: result.data.totpURI,
        backupCodes: result.data.backupCodes,
      });
      return;
    }

    if (action === "disable") {
      const result = await authClient.twoFactor.disable({ password });
      setPending(false);

      if (result.error) {
        setError(describeError(result.error));
        return;
      }

      await refetch();
      reset();
      return;
    }

    const result = await authClient.twoFactor.generateBackupCodes({
      password,
    });
    setPending(false);

    if (result.error || !result.data?.backupCodes) {
      setError(describeError(result.error ?? {}));
      return;
    }

    setStep({ kind: "codes", backupCodes: result.data.backupCodes });
  }

  async function verifyEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (step.kind !== "scan") {
      return;
    }

    setError(undefined);
    setPending(true);

    const code = String(new FormData(event.currentTarget).get("code")).trim();
    const result = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);

    if (result.error) {
      setError(
        result.error.status === 429
          ? describeError(result.error)
          : "That code is not valid. Check the time on your device and try again.",
      );
      return;
    }

    await refetch();
    setStep({ kind: "codes", backupCodes: step.backupCodes });
  }

  const secret = totpURI
    ? (new URL(totpURI).searchParams.get("secret") ?? undefined)
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          <Badge variant={enabled ? "tag" : "outline"}>
            {enabled ? "On" : "Off"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Ask for a code from an authenticator app every time you sign in.
          Turning it on or off signs out your other sessions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step.kind === "idle" && (
          <div className="flex flex-wrap gap-2">
            {enabled ? (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    setStep({ kind: "confirm-password", action: "regenerate" })
                  }
                >
                  New recovery codes
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    setStep({ kind: "confirm-password", action: "disable" })
                  }
                >
                  Turn off
                </Button>
              </>
            ) : (
              <Button
                onClick={() =>
                  setStep({ kind: "confirm-password", action: "enable" })
                }
              >
                Turn on
              </Button>
            )}
          </div>
        )}

        {step.kind === "confirm-password" && (
          <form
            className="max-w-sm space-y-4"
            onSubmit={(event) => confirmPassword(event, step.action)}
          >
            <div className="space-y-2">
              <Label htmlFor="twoFactorPassword">Confirm your password</Label>
              <Input
                id="twoFactorPassword"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Checking…" : PASSWORD_PROMPTS[step.action]}
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step.kind === "scan" && (
          <form className="space-y-4" onSubmit={verifyEnrollment}>
            <p className="text-sm text-muted-foreground">
              Scan this code with your authenticator app, or enter the setup key
              by hand, then type the 6-digit code it shows.
            </p>
            {qrCode && (
              <img
                src={qrCode}
                alt="Authenticator setup QR code"
                width={192}
                height={192}
                className="rounded-md border bg-white"
              />
            )}
            {secret && (
              <p className="break-all font-mono text-sm">Setup key: {secret}</p>
            )}
            <div className="max-w-sm space-y-2">
              <Label htmlFor="enrollCode">Authentication code</Label>
              <Input
                id="enrollCode"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Verifying…" : "Verify and turn on"}
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step.kind === "codes" && (
          <div className="space-y-4">
            <RecoveryCodes codes={step.backupCodes} />
            <Button onClick={reset}>Done</Button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
