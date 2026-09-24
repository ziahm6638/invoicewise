#!/usr/bin/env bash
#
# Regression check for the bootstrap self-check lifecycle.
#
# Root reproduced a destructive version of `--self-check` that force-removed a
# container named `<caller-prefix>-postgres` before probing refusal. This script
# creates an unowned, disposable container under a random caller prefix, runs
# the self-check with that prefix, and requires the exact container ID to
# survive. Only the container it creates is removed, by captured ID.
set -euo pipefail

PREFIX="iw-verify-callercheck-$(date +%s)-$$"
NAME="${PREFIX}-postgres"
LOG_FILE="$(mktemp -t verify-callercheck.XXXXXX)"
CONTAINER_ID=""

cleanup() {
  [ -n "${CONTAINER_ID}" ] && docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

CONTAINER_ID="$(docker run -d --name "${NAME}" \
  --label invoicewise.verify.callercheck=true \
  redis:7.4-alpine)"

set +e
VERIFY_CONTAINER_PREFIX="${PREFIX}" bash "$(dirname "$0")/ci-services.sh" --self-check >"${LOG_FILE}" 2>&1
status=$?
set -e

if [ "${status}" -ne 0 ]; then
  echo "caller-prefix check failed: self-check exited ${status}" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

if ! docker inspect "${CONTAINER_ID}" >/dev/null 2>&1; then
  echo "caller-prefix check failed: the unowned caller container was removed" >&2
  exit 1
fi

current_id="$(docker inspect --format '{{.Id}}' "${NAME}" 2>/dev/null || true)"
if [ "${current_id}" != "${CONTAINER_ID}" ]; then
  echo "caller-prefix check failed: container identity changed (${current_id:0:12} != ${CONTAINER_ID:0:12})" >&2
  exit 1
fi

if ! grep -q "self-check passed" "${LOG_FILE}"; then
  echo "caller-prefix check failed: the self-check did not report success" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

echo "caller-prefix safety: unowned container ${CONTAINER_ID:0:12} survived the self-check under prefix ${PREFIX}"
