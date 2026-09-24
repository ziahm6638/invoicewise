#!/bin/sh
# Production preflight for the Kamal roles (config/deploy.yml): refuse to start
# when required configuration is missing, before migrations run or a port opens.
# Several settings otherwise fail only on first use (extraction, signed links,
# encrypted columns) or silently fall back to a development default (documents
# in the container's /tmp), so a release could pass its health check while
# broken. Only variable names are ever printed, never values.
#
# Usage: require-env.sh web|api
set -eu

role="${1:-}"

common="DATABASE_PRIMARY_URL REDIS_URL BETTER_AUTH_URL BETTER_AUTH_SECRET
SMTP_USER SMTP_PASS AUTH_EMAIL_FROM STORAGE_BACKEND STORAGE_SIGNING_SECRET
STORAGE_PUBLIC_URL MIDDAY_ENCRYPTION_KEY"

case "$role" in
  web) required="$common NEXT_PUBLIC_URL NEXT_PUBLIC_API_URL" ;;
  api) required="$common ALLOWED_API_ORIGINS TYPESAFE_API_KEY NANGO_BASE_URL NANGO_SECRET_KEY" ;;
  *)
    echo "usage: require-env.sh web|api" >&2
    exit 2
    ;;
esac

case "${STORAGE_BACKEND:-}" in
  local) required="$required LOCAL_STORAGE_PATH" ;;
  s3)
    required="$required STORAGE_S3_ENDPOINT STORAGE_S3_BUCKET
STORAGE_S3_ACCESS_KEY_ID STORAGE_S3_SECRET_ACCESS_KEY"
    ;;
esac

missing=""
for name in $required; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done

problems=""
[ -z "$missing" ] || problems="missing:$missing"

if [ "${NODE_ENV:-}" != "production" ]; then
  problems="$problems${problems:+; }NODE_ENV must be production"
fi

case "${STORAGE_BACKEND:-}" in
  "" | local | s3) ;;
  *) problems="$problems${problems:+; }STORAGE_BACKEND must be local or s3" ;;
esac

if [ -n "${MIDDAY_ENCRYPTION_KEY:-}" ] &&
  ! printf '%s' "$MIDDAY_ENCRYPTION_KEY" | grep -Eq '^[0-9a-fA-F]{64}$'; then
  problems="$problems${problems:+; }MIDDAY_ENCRYPTION_KEY must be 64 hex characters"
fi

if [ -n "$problems" ]; then
  echo "invoicewise-$role refusing to start: $problems" >&2
  exit 1
fi
