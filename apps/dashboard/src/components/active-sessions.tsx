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
import { useCallback, useEffect, useState } from "react";

type ActiveSession = {
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** A short, human label for a user-agent string. */
export function describeDevice(userAgent?: string | null) {
  if (!userAgent) {
    return "Unknown device";
  }

  const browser =
    [
      ["Edg/", "Edge"],
      ["OPR/", "Opera"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
    ].find(([marker]) => userAgent.includes(marker!))?.[1] ?? "Browser";

  const system =
    [
      ["iPhone", "iPhone"],
      ["iPad", "iPad"],
      ["Android", "Android"],
      ["Mac OS X", "macOS"],
      ["Windows", "Windows"],
      ["Linux", "Linux"],
    ].find(([marker]) => userAgent.includes(marker!))?.[1] ?? null;

  return system ? `${browser} on ${system}` : browser;
}

const formatDate = (value: Date | string) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * Every signed-in session for this account. Revoking one deletes its session
 * row, so that browser or bearer token is rejected on its next request.
 */
export function ActiveSessions() {
  const { data: current } = authClient.useSession();
  const currentToken = current?.session?.token;
  const [sessions, setSessions] = useState<ActiveSession[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();

  const load = useCallback(async () => {
    const result = await authClient.listSessions();

    if (result.error) {
      setError("Could not load your sessions.");
      return;
    }

    setSessions(
      [...(result.data ?? [])].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: string) {
    setError(undefined);
    setPending(token);
    const result = await authClient.revokeSession({ token });
    setPending(undefined);

    if (result.error) {
      setError("Could not sign that session out. Try again.");
      return;
    }

    await load();
  }

  async function revokeOthers() {
    setError(undefined);
    setPending("others");
    const result = await authClient.revokeOtherSessions();
    setPending(undefined);

    if (result.error) {
      setError("Could not sign out your other sessions. Try again.");
      return;
    }

    await load();
  }

  const others = sessions?.filter((session) => session.token !== currentToken);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>
          Devices signed in to your account. Sign out any you do not recognise,
          then change your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!sessions && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {sessions && (
          <ul className="divide-y rounded-md border">
            {sessions.map((session) => {
              const isCurrent = session.token === currentToken;

              return (
                <li
                  key={session.token}
                  className="flex items-center justify-between gap-4 p-3"
                >
                  <div className="space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {describeDevice(session.userAgent)}
                      {isCurrent && <Badge variant="tag">This device</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {session.ipAddress ? `${session.ipAddress} · ` : ""}
                      Signed in {formatDate(session.createdAt)} · Last active{" "}
                      {formatDate(session.updatedAt)}
                    </p>
                  </div>
                  {!isCurrent && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending !== undefined}
                      onClick={() => revoke(session.token)}
                    >
                      {pending === session.token ? "Signing out…" : "Sign out"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {others && others.length > 0 && (
          <Button
            variant="outline"
            disabled={pending !== undefined}
            onClick={revokeOthers}
          >
            {pending === "others"
              ? "Signing out…"
              : "Sign out all other sessions"}
          </Button>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
