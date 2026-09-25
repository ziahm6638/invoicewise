/**
 * Writes the published v1 contract to docs/api/openapi-v1.json. The API test
 * suite fails when the served contract and this file differ, so a change to
 * the public API is always a deliberate, reviewed diff (docs/api.md#versioning).
 */
import { writeFileSync } from "node:fs";
import { publicApiContract } from "../effect/public-api-http";

const target = new URL("../../../../docs/api/openapi-v1.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(publicApiContract(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
process.exit(0);
