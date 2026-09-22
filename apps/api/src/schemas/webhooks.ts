import { WEBHOOK_EVENTS } from "@midday/db/queries";
import { isAllowedWebhookUrl } from "@midday/jobs/webhooks";
import { z } from "zod";

const endpointUrl = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine(
    (value) =>
      isAllowedWebhookUrl(value, process.env.NODE_ENV !== "production"),
    "Webhook URLs must use public HTTPS (localhost is development-only)",
  );

export const createWebhookEndpointSchema = z.object({
  url: endpointUrl,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

export const webhookEndpointIdSchema = z.object({ id: z.string().uuid() });
