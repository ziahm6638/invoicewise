import { RedisCache } from "./redis-client";

// One long-lived client: a new cache per check would open a connection each
// time it is called.
const healthChecker = new RedisCache("health", 0);

export async function checkHealth(): Promise<void> {
  await healthChecker.healthCheck();
}
