import { getSession } from "@/lib/auth";
import { handleInvoiceIntake } from "@invoicewise/api/intake/http";
import { primaryDb } from "@invoicewise/db/client";
import { defaultIntakeStorage } from "@invoicewise/jobs/intake";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.teamId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleInvoiceIntake(request, {
    teamId: session.teamId,
    db: primaryDb,
    storage: defaultIntakeStorage,
  });
}
