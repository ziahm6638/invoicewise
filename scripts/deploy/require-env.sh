#!/bin/sh
# Production preflight for the Kamal roles (config/deploy.yml): refuse to start
# when required configuration is missing, before migrations run or a port opens.
# Several settings otherwise fail only on first use (extraction, signed links,
# encrypted columns) or silently fall back to a development default (documents
# in the container's /tmp), so a release could pass its health check while
# broken. It also refuses malformed bounds (pools, concurrency, queue and spend
# ceilings), non-https public URLs, a short operator token and a staging
# cookie domain that would reach production hosts. Only variable names
# are ever printed, never values.
#
# Usage: require-env.sh web|api
set -eu

role="${1:-}"

common="INVOICEWISE_ENVIRONMENT DATABASE_PRIMARY_URL DATABASE_POOL_MAX REDIS_URL
BETTER_AUTH_URL BETTER_AUTH_SECRET SMTP_USER SMTP_PASS AUTH_EMAIL_FROM
STORAGE_BACKEND STORAGE_SIGNING_SECRET STORAGE_PUBLIC_URL MIDDAY_ENCRYPTION_KEY"

case "$role" in
  web) required="$common NEXT_PUBLIC_URL NEXT_PUBLIC_API_URL" ;;
  api) required="$common ALLOWED_API_ORIGINS TYPESAFE_API_KEY
TYPESAFE_DAILY_CALL_LIMIT WORKFLOW_CONCURRENCY NANGO_BASE_URL NANGO_SECRET_KEY
OPS_TOKEN" ;;
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

case "${INVOICEWISE_ENVIRONMENT:-}" in
  "" | production) ;;
  staging)
    # Browsers send a cookie to every host under its domain, so staging's
    # cookie domain must not cover a production host.
    cookie_domain=$(printf '%s' "${BETTER_AUTH_COOKIE_DOMAIN:-}" | tr 'A-Z' 'a-z')
    cookie_domain=${cookie_domain#.}
    if [ -z "$cookie_domain" ]; then
      problems="$problems${problems:+; }staging needs its own BETTER_AUTH_COOKIE_DOMAIN"
    else
      for production_host in app.invoicewise.uk api.invoicewise.uk; do
        case "$production_host" in
          "$cookie_domain" | *".$cookie_domain")
            problems="$problems${problems:+; }staging BETTER_AUTH_COOKIE_DOMAIN must not cover production hosts"
            break
            ;;
        esac
      done
    fi
    ;;
  *) problems="$problems${problems:+; }INVOICEWISE_ENVIRONMENT must be production or staging" ;;
esac

# Bounds on pools, concurrency, queued work and provider spend must be
# positive whole numbers: a typo would otherwise fall back to a default.
for name in DATABASE_POOL_MAX WORKFLOW_CONCURRENCY TYPESAFE_DAILY_CALL_LIMIT \
  INTAKE_MAX_PENDING_PER_WORKSPACE INTAKE_MAX_PENDING_TOTAL; do
  eval "value=\${$name:-}"
  [ -z "$value" ] && continue
  printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$' ||
    problems="$problems${problems:+; }$name must be a positive whole number"
done

for name in BETTER_AUTH_URL NEXT_PUBLIC_URL NEXT_PUBLIC_API_URL STORAGE_PUBLIC_URL; do
  eval "value=\${$name:-}"
  [ -z "$value" ] && continue
  case "$value" in
    https://*) ;;
    *) problems="$problems${problems:+; }$name must be an https URL" ;;
  esac
done

if [ -n "${OPS_TOKEN:-}" ] && [ "${#OPS_TOKEN}" -lt 32 ]; then
  problems="$problems${problems:+; }OPS_TOKEN must be at least 32 characters"
fi

if [ -n "$problems" ]; then
  echo "invoicewise-$role refusing to start: $problems" >&2
  exit 1
fi
