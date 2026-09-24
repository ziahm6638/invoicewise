import type { Session } from "@api/utils/auth";
import type { Database } from "@invoicewise/db/client";
import type { TeamRole } from "@invoicewise/db/queries";

export type Context = {
  Variables: {
    db: Database;
    session: Session;
    teamId: string;
    teamRole: TeamRole | null;
  };
};
