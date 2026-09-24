#!/usr/bin/env bash
#
# Starts the disposable verification services with explicit server commands.
#
# Safety properties:
#   * every published port is bound to 127.0.0.1 only (never all interfaces),
#   * containers are labelled as verification-owned and only removed when they
#     carry both the ownership label and this run's prefix; a name collision
#     with a container we do not own is refused instead of force-removed,
#   * the published host IP is asserted after start,
#   * `--self-check` proves the refusal in its own freshly generated namespace,
#     never touching the caller's or the default service names, and cleans up
#     only the exact container IDs it created.
#
# The pinned MinIO image's default command only prints help, and the `mc` image
# entrypoint is `mc`, so MinIO is started with an explicit `server /data`
# command and the verification runner creates the private bucket through the S3
# API (scripts/verify/minio.ts).
#
# Usage:
#   bash scripts/verify/ci-services.sh                # start the services
#   bash scripts/verify/ci-services.sh --self-check   # prove collision refusal
#
# Environment overrides (used to run beside a development stack):
#   VERIFY_CONTAINER_PREFIX, VERIFY_PG_PORT, VERIFY_REDIS_PORT,
#   VERIFY_MINIO_PORT, VERIFY_SERVICES_TEARDOWN=1
set -euo pipefail

NAME_PREFIX="${VERIFY_CONTAINER_PREFIX:-invoicewise-verify-services}"
PG_PORT="${VERIFY_PG_PORT:-5432}"
REDIS_PORT="${VERIFY_REDIS_PORT:-6379}"
MINIO_PORT="${VERIFY_MINIO_PORT:-9000}"

POSTGRES_IMAGE="pgvector/pgvector:0.8.1-pg17"
REDIS_IMAGE="redis:7.4-alpine"
# MinIO no longer publishes pullable images (quay.io/minio and Docker Hub now
# refuse anonymous pulls), so this is Chainguard's build, pinned by digest.
MINIO_IMAGE="cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1"

OWNER_LABEL="invoicewise.verify.service"
PREFIX_LABEL="invoicewise.verify.prefix"
DECOY_LABEL="invoicewise.verify.decoy"

CONTAINER_IDS=()

container_name() {
  echo "${NAME_PREFIX}-$1"
}

label_of() {
  docker inspect --format "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null || true
}

# Removes a container only when it is verification-owned by this run's prefix;
# refuses otherwise.
prepare_name() {
  local name="$1"
  if ! docker inspect "${name}" >/dev/null 2>&1; then
    return 0
  fi
  local owner
  owner="$(label_of "${name}" "${OWNER_LABEL}")"
  if [ "${owner}" != "true" ]; then
    echo "refusing to remove existing container '${name}': it is not labelled ${OWNER_LABEL}=true (owned by someone else)" >&2
    exit 3
  fi
  local prefix
  prefix="$(label_of "${name}" "${PREFIX_LABEL}")"
  if [ "${prefix}" != "${NAME_PREFIX}" ]; then
    echo "refusing to remove existing container '${name}': it belongs to verification prefix '${prefix}'" >&2
    exit 3
  fi
  echo "removing previous verification container ${name}"
  docker rm -f "${name}" >/dev/null
}

assert_loopback_publish() {
  local name="$1"
  local published
  published="$(docker inspect --format '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{.HostIp}} {{end}}{{end}}' "${name}")"
  if [ -z "${published// /}" ]; then
    echo "container '${name}' published no port bindings" >&2
    exit 4
  fi
  for host_ip in ${published}; do
    if [ "${host_ip}" != "127.0.0.1" ]; then
      echo "container '${name}' is published on '${host_ip}' instead of 127.0.0.1" >&2
      exit 4
    fi
  done
}

start_service() {
  local name="$1"
  shift
  prepare_name "${name}"
  local id
  id="$(docker run -d --name "${name}" \
    --label "${OWNER_LABEL}=true" \
    --label "${PREFIX_LABEL}=${NAME_PREFIX}" \
    "$@")"
  CONTAINER_IDS+=("${id}")
  assert_loopback_publish "${name}"
}

# Removes only the containers this run created, by exact ID.
remove_created_containers() {
  local id
  for id in "${CONTAINER_IDS[@]:-}"; do
    [ -n "${id}" ] || continue
    docker rm -f "${id}" >/dev/null 2>&1 || true
  done
  CONTAINER_IDS=()
}

run_self_check() {
  # Fresh namespace, independent of the caller's/default service prefix: the
  # check can never collide with (or remove) the services the caller is about
  # to start or is already running.
  local self_prefix="invoicewise-verify-selfcheck-$(date +%s)-$$"
  local live_prefix="${self_prefix}-live"
  local decoy_name="${self_prefix}-postgres"
  local live_name="${live_prefix}-postgres"
  local decoy_id=""
  local live_id=""
  local log_file
  log_file="$(mktemp -t verify-selfcheck.XXXXXX)"

  cleanup_self_check() {
    # Exact captured IDs only; never a name pattern.
    [ -n "${decoy_id}" ] && docker rm -f "${decoy_id}" >/dev/null 2>&1 || true
    [ -n "${live_id}" ] && docker rm -f "${live_id}" >/dev/null 2>&1 || true
    rm -f "${log_file}"
  }
  trap cleanup_self_check EXIT

  if docker inspect "${decoy_name}" >/dev/null 2>&1; then
    echo "self-check failed: generated name ${decoy_name} is unexpectedly occupied" >&2
    exit 1
  fi

  echo "self-check: proving refusal for an unowned container named ${decoy_name}"
  decoy_id="$(docker run -d --name "${decoy_name}" \
    --label "${DECOY_LABEL}=true" \
    "${REDIS_IMAGE}")"

  # A live verification-owned service under a different prefix must also survive.
  live_id="$(docker run -d --name "${live_name}" \
    --label "${OWNER_LABEL}=true" \
    --label "${PREFIX_LABEL}=${live_prefix}" \
    "${REDIS_IMAGE}")"

  local status
  set +e
  VERIFY_CONTAINER_PREFIX="${self_prefix}" bash "$0" >"${log_file}" 2>&1
  status=$?
  set -e

  if [ "${status}" -eq 0 ]; then
    echo "self-check failed: the bootstrap started despite an unowned name collision" >&2
    exit 1
  fi
  if ! grep -q "refusing to remove existing container" "${log_file}"; then
    echo "self-check failed: the refusal message was not emitted" >&2
    cat "${log_file}" >&2
    exit 1
  fi

  local id
  for id in "${decoy_id}" "${live_id}"; do
    if ! docker inspect "${id}" >/dev/null 2>&1; then
      echo "self-check failed: pre-existing container ${id} was removed" >&2
      exit 1
    fi
  done

  local decoy_still="${decoy_id}"
  local live_still="${live_id}"

  # Surface the observed refusal and the surviving IDs as evidence.
  grep "refusing to remove existing container" "${log_file}" || true
  echo "self-check: unowned ordinary container ${decoy_still:0:12} and live verification container ${live_still:0:12} both still present"

  cleanup_self_check
  trap - EXIT
  echo "self-check passed: unowned container survived (${decoy_still:0:12}), live verification container survived (${live_still:0:12}), status ${status}"
  exit 0
}

if [ "${1:-}" = "--self-check" ]; then
  run_self_check
fi

teardown() {
  if [ "${VERIFY_SERVICES_TEARDOWN:-0}" = "1" ]; then
    remove_created_containers
  fi
}
trap teardown EXIT

start_service "$(container_name postgres)" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -e POSTGRES_USER=invoicewise \
  -e POSTGRES_PASSWORD=invoicewise \
  -e POSTGRES_DB=invoicewise \
  "${POSTGRES_IMAGE}"

start_service "$(container_name redis)" \
  -p "127.0.0.1:${REDIS_PORT}:6379" \
  "${REDIS_IMAGE}"

start_service "$(container_name minio)" \
  -p "127.0.0.1:${MINIO_PORT}:9000" \
  -e MINIO_ROOT_USER=invoicewise \
  -e MINIO_ROOT_PASSWORD=invoicewise-secret \
  "${MINIO_IMAGE}" server /data

echo "waiting for postgres on ${PG_PORT}, redis on ${REDIS_PORT}, minio on ${MINIO_PORT} (loopback only)"
deadline=$((SECONDS + 120))
until docker exec "$(container_name postgres)" pg_isready -h 127.0.0.1 -U invoicewise -d invoicewise >/dev/null 2>&1; do
  [ "${SECONDS}" -lt "${deadline}" ] || { echo "postgres did not become ready" >&2; docker logs "$(container_name postgres)" >&2 || true; exit 1; }
  sleep 2
done

until docker exec "$(container_name redis)" redis-cli ping >/dev/null 2>&1; do
  [ "${SECONDS}" -lt "${deadline}" ] || { echo "redis did not become ready" >&2; docker logs "$(container_name redis)" >&2 || true; exit 1; }
  sleep 2
done

until curl --fail --silent "http://127.0.0.1:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1; do
  [ "${SECONDS}" -lt "${deadline}" ] || { echo "minio did not become ready" >&2; docker logs "$(container_name minio)" >&2 || true; exit 1; }
  sleep 2
done

echo "verification services ready (127.0.0.1 only)"
