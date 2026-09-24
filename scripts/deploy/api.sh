#!/bin/sh
# Kamal `api` role: checks required configuration, applies pending migrations,
# then serves the API and runs the workflow runner in the same process
# (api.invoicewise.uk).
# Migrations are append-only and run inside one transaction; kamal-proxy only
# routes traffic to this container once /health passes.
set -eu
/app/scripts/deploy/require-env.sh api
cd /app/packages/db
bun --no-env-file x drizzle-kit migrate
cd /app/apps/api
exec bun --no-env-file src/index.ts
