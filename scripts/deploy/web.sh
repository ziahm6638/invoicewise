#!/bin/sh
# Kamal `web` role: the Next.js dashboard (app.invoicewise.uk).
set -eu
cd /app/apps/dashboard
exec bun --no-env-file x next start -p "${PORT:-3000}"
