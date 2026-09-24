import { getQueryClient, trpc } from "@/trpc/server";
import { db } from "@invoicewise/db/client";
import { enqueueWorkflow, workflowKey } from "@invoicewise/jobs";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // An opaque, single-use value bound to the session that started the
  // connect; the API refuses a replayed, expired or foreign one.
  const state = searchParams.get("state");
  const queryClient = getQueryClient();

  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing required parameters" },
      { status: 400 },
    );
  }

  try {
    const account = await queryClient.fetchQuery(
      trpc.inboxAccounts.exchangeCodeForAccount.queryOptions({
        code,
        state,
      }),
    );

    if (!account) {
      return NextResponse.redirect(
        new URL("/invoices?connected=failed", request.url),
        { status: 302 },
      );
    }

    await enqueueWorkflow(db, {
      name: "initial-inbox-setup",
      idempotencyKey: workflowKey.inboxSetup(account.id),
      payload: { id: account.id },
    });

    return NextResponse.redirect(
      new URL(
        `/invoices?connected=true&provider=${account.provider}`,
        request.url,
      ),
      {
        status: 302,
      },
    );
  } catch (error) {
    console.error(error);
    return NextResponse.redirect(
      new URL("/invoices?connected=false", request.url),
      { status: 302 },
    );
  }
}
