import { checkHealth as checkDbHealth } from "@invoicewise/db/utils/health";

export async function checkHealth(): Promise<void> {
  await checkDbHealth();
}
