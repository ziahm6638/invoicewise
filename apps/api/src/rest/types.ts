import type { Session } from "@api/utils/auth";
import type { Scope } from "@api/utils/scopes";
import type { Database } from "@invoicewise/db/client";
import type { TeamRole } from "@invoicewise/db/queries";

export type Context = {
  Variables: {
    db: Database;
    session: Session;
    teamId: string;
    teamRole: TeamRole | null;
    scopes: Scope[];
    /** The API key or OAuth application behind the request (audit trail). */
    credentialId: string | null;
  };
};
