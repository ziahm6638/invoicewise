import { logger } from "@/utils/logger";
import { deliverMail } from "@api/services/mail";
import { db, primaryDb } from "@invoicewise/db/client";
import { teams } from "@invoicewise/db/schema";
import { getAllowedAttachments } from "@invoicewise/documents";
import { LogEvents } from "@invoicewise/events/events";
import { setupAnalytics } from "@invoicewise/events/server";
import {
  getInboxIdFromEmail,
  inboxWebhookPostSchema,
} from "@invoicewise/inbox";
import {
  acceptIntakeUpload,
  defaultIntakeStorage,
} from "@invoicewise/jobs/intake";
import { isTransientIntakeFailure } from "@invoicewise/jobs/intake-failure";
import { getExtensionFromMimeType } from "@invoicewise/utils";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

// https://postmarkapp.com/support/article/800-ips-for-firewalls#webhooks
const ipRange = [
  "3.134.147.250",
  "50.31.156.6",
  "50.31.156.77",
  "18.217.206.57",
];

const FORWARD_FROM_EMAIL = "inbox@midday.ai";

// These are used by Google Workspace to forward emails to our inbox
const ALLOWED_FORWARDING_EMAILS = ["forwarding-noreply@google.com"];

export async function POST(req: Request) {
  const clientIp = (await headers()).get("x-forwarded-for") ?? "";

  if (
    process.env.NODE_ENV !== "development" &&
    (!clientIp || !ipRange.includes(clientIp))
  ) {
    return NextResponse.json({ error: "Invalid IP address" }, { status: 403 });
  }

  const parsedBody = inboxWebhookPostSchema.safeParse(await req.json());

  if (!parsedBody.success) {
    const errors = parsedBody.error.errors.map((error) => ({
      path: error.path.join("."),
      message: error.message,
    }));

    return NextResponse.json(
      { error: "Invalid request body", errors },
      { status: 400 },
    );
  }

  const {
    MessageID,
    FromFull,
    Subject,
    Attachments,
    OriginalRecipient,
    TextBody,
    HtmlBody,
  } = parsedBody.data;

  const inboxId = getInboxIdFromEmail(OriginalRecipient);

  if (!inboxId) {
    return NextResponse.json(
      { error: "Invalid OriginalRecipient email" },
      { status: 400 },
    );
  }

  // Ignore emails from our own domain to fix infinite loop
  if (FromFull.Email === FORWARD_FROM_EMAIL) {
    return NextResponse.json({ success: true });
  }

  try {
    const [teamData] = await db
      .select({ id: teams.id, email: teams.email })
      .from(teams)
      .where(eq(teams.inboxId, inboxId));

    if (!teamData) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    const analytics = await setupAnalytics();

    analytics.track({
      event: LogEvents.InboxInbound.name,
      channel: LogEvents.InboxInbound.channel,
    });

    const teamId = teamData.id;

    // If the email is forwarded from a Google Workspace account, we need to send a reply to the team email.
    // It is sent from AUTH_EMAIL_FROM: the SMTP account only relays for its own addresses.
    if (teamData?.email && ALLOWED_FORWARDING_EMAILS.includes(FromFull.Email)) {
      await deliverMail({
        to: teamData.email,
        subject: Subject ?? FromFull?.Name,
        text: TextBody,
        html: HtmlBody,
        headers: {
          "X-Entity-Ref-ID": nanoid(),
        },
      });

      return NextResponse.json({ success: true });
    }

    const allowedAttachments = getAllowedAttachments(Attachments);

    if (!allowedAttachments?.length) {
      logger("No allowed attachments");
      // No attachments
      return NextResponse.json({ success: true });
    }

    // Transform and upload files, filtering out attachments smaller than 100kb except PDFs
    // This helps avoid processing small images like logos, favicons and tracking pixels while keeping all PDFs for processing
    // Note: application/octet-stream is also allowed regardless of size since PDFs are often sent with this generic MIME type
    const candidateAttachments =
      allowedAttachments?.filter(
        (attachment) =>
          !(
            attachment.ContentLength < 100000 &&
            attachment.ContentType !== "application/pdf" &&
            attachment.ContentType !== "application/octet-stream"
          ),
      ) ?? [];

    if (!candidateAttachments.length) {
      logger("No uploaded attachments");

      return NextResponse.json({
        success: true,
      });
    }

    // Attachments go through intake one at a time. The isolated PDF parser
    // admits a small bounded number of documents, so validating every
    // attachment of a large email at once would exhaust admission and turn
    // every provider retry into the same 503.
    const intakeResults: Awaited<ReturnType<typeof acceptIntakeUpload>>[] = [];
    for (const [index, attachment] of candidateAttachments.entries()) {
      // Add a random 4 character string to the end of the file name
      // to make it unique before the extension
      const hasExtension = /\.[^.]+$/.test(attachment.Name);
      const uniqueFileName = hasExtension
        ? attachment.Name.replace(/(\.[^.]+)$/, (ext) => `_${nanoid(4)}${ext}`)
        : `${attachment.Name}_${nanoid(4)}${getExtensionFromMimeType(attachment.ContentType)}`;

      // Intake owns object identity, validation and the processing intent.
      intakeResults.push(
        await acceptIntakeUpload(primaryDb, defaultIntakeStorage, {
          teamId,
          bytes: new Uint8Array(Buffer.from(attachment.Content, "base64")),
          declaredMimeType: attachment.ContentType,
          // NOTE: If we can't parse the name using OCR this will be the fallback name
          displayName: Subject || attachment.Name,
          fileName: uniqueFileName,
          // Two same-named attachments in one message are separate
          // occurrences, and provider identity is workspace scoped.
          referenceId: `${MessageID}_${index}_${attachment.Name}`,
        }),
      );
    }

    let transientFailures = 0;

    for (const result of intakeResults) {
      if (result.status !== "rejected") continue;

      // A transient storage/enqueue failure is recoverable: tell the provider
      // to retry instead of silently losing the attachment. Permanent
      // rejections stay visible in the log and are not retried.
      if (isTransientIntakeFailure(result.code)) {
        transientFailures += 1;
      }
      logger(`Attachment rejected (${result.code}): ${result.message}`);
    }

    if (transientFailures > 0) {
      return NextResponse.json(
        {
          error: `${transientFailures} attachment(s) could not be stored; retry the delivery`,
        },
        { status: 503 },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    logger(message);

    return NextResponse.json(
      { error: `Failed to create record for ${inboxId}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
