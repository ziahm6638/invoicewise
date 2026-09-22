import { getPlanByProductId } from "@/utils/plans";
import { db } from "@midday/db/client";
import { updateTeamById } from "@midday/db/queries";
import { Webhooks } from "@polar-sh/nextjs";

export const POST = Webhooks({
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  onPayload: async (payload) => {
    switch (payload.type) {
      case "subscription.active": {
        await updateTeamById(db, {
          id: payload.data.metadata.teamId as string,
          data: {
            email: payload.data.customer.email ?? undefined,
            plan: getPlanByProductId(payload.data.productId) as
              | "starter"
              | "pro",
            canceledAt: null,
          },
        });

        break;
      }

      // Subscription has been explicitly canceled by the user
      case "subscription.canceled": {
        await updateTeamById(db, {
          id: payload.data.metadata.teamId as string,
          data: {
            email: payload.data.customer.email ?? undefined,
            canceledAt: new Date().toISOString(),
          },
        });

        break;
      }

      // Subscription has been revoked/peroid has ended with no renewal
      case "subscription.revoked": {
        if (!payload.data.metadata.teamId) {
          console.error("Customer ID or email is missing");
          break;
        }

        await updateTeamById(db, {
          id: payload.data.metadata.teamId as string,
          data: { plan: "trial", canceledAt: new Date().toISOString() },
        });

        break;
      }
      default:
        console.log("Unknown event", payload.type);
        break;
    }
  },
});
