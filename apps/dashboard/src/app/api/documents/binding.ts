import { getSession } from "@/lib/auth";
import { primaryDb } from "@invoicewise/db/client";
import type { InboxIntakeBinding } from "@invoicewise/db/queries";
import { resolveTeamDocumentBinding } from "@invoicewise/jobs/intake";

/**
 * Resolves the caller's workspace binding for an inbox id. Client input is
 * only an id; path, type and size always come from the persisted record.
 */
export async function resolveDocumentBinding(
  id: string | null,
): Promise<InboxIntakeBinding | null> {
  const session = await getSession();
  if (!session?.teamId || !id) return null;

  return resolveTeamDocumentBinding(primaryDb, {
    teamId: session.teamId,
    id,
  });
}

export const documentHeaders = (input: {
  contentType: string;
  fileName: string;
  download: boolean;
}) => ({
  "Content-Type": input.contentType,
  "Content-Disposition": `${input.download ? "attachment" : "inline"}; filename="${input.fileName.replace(
    /[^\w.\- ]/g,
    "_",
  )}"`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
});
