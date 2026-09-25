---
name: local-verify-hygiene
description: Use when running `bun run verify` or its backing service containers on a shared or busy machine, when verify fails with timeouts or a different test on each run, or when cleaning up containers and disk after verification. Covers service-suite etiquette, the collisions per-run ports do not prevent, load-related false failures and cleanup.
---

# Running local verification without hurting the machine

What `bun run verify` checks, and its isolation guarantees, are owned by `docs/development.md#release-verification`.
This skill is only about running it safely and reading its failures on a shared machine; it does not change or describe the gate itself.

## One service suite at a time

- Before starting Postgres, Redis or MinIO, look for an existing suite:
  ```bash
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -i -E 'invoicewise|iw-'
  docker ps --filter label=invoicewise.verify.service=true --format '{{.Names}} {{.Label "invoicewise.verify.prefix"}}'
  ```
  If someone else's suite is running, wait for it to finish. Do not start a parallel copy: several parallel suites plus their builds have exhausted memory on a shared machine.
- **Two runs cannot share one suite at the same time.** The per-run app ports (`VERIFY_API_PORT`, `INTAKE_TEST_PORT` and the rest) only stop port clashes. Database names are fixed (`invoicewise_perms_test`, `invoicewise_intake_test`, `invoicewise_jobs_verify_test` … in `scripts/verify/release.ts`) and are recreated with `WITH (FORCE)`, and every run uses Redis logical database 9 by default. Two runs against one suite drop each other's databases mid-test. Run them one after the other.
- A separate suite for a genuinely parallel run needs its own prefix and ports (the recipe is in `docs/development.md`): `VERIFY_CONTAINER_PREFIX`, `VERIFY_PG_PORT`, `VERIFY_REDIS_PORT` and `VERIFY_MINIO_PORT` for `bash scripts/verify/ci-services.sh`, then `VERIFY_POSTGRES_BASE` (a server URL with no database name, e.g. `postgresql://invoicewise:invoicewise@localhost:<port>`), `VERIFY_REDIS_URL` and `VERIFY_MINIO_ENDPOINT` for the run. Only do this when the machine has room.
- The default ports (5432, 6379, 9000) are the same as the `docker compose` development stack; stop that stack or use a prefix and ports.

## Cleaning up

- When you finish, remove the suite you started, with its anonymous volumes (otherwise they pile up as dangling volumes):
  ```bash
  docker rm -f -v <prefix>-postgres <prefix>-redis <prefix>-minio
  ```
  `VERIFY_SERVICES_TEARDOWN=1` only removes them when `ci-services.sh` itself exits, which is useful in CI but not for a suite you keep between runs.
- Delete `.verify-artifacts/` once you have read `summary.json`: a run that was killed skips its own cleanup and leaves a multi-GB workspace overlay with production builds under `.verify-artifacts/<run-id>/tmp`. Bundled executables also sit in `apps/api/.verify-artifacts` and `packages/jobs/.verify-artifacts`.
  ```bash
  find . -name .verify-artifacts -type d -prune -not -path '*/node_modules/*' -exec du -sh {} +
  ```
- Never prune volumes or containers you did not create; other projects share the Docker host.

## Failures that are not your code

- **Load.** Check `uptime` before blaming a change. Under heavy load (load average well above the core count) bun's 5 s default test timeout and timing assertions fail with a different test on each run. Rerun the single failing step when the load drops. If the same test fails the same way on a quiet machine, it is real.
- **Killed run.** A verify that the host's memory pressure killed (the process vanishes with no final summary, or reports a signal) is not a pass. Rerun it in full before reporting green.
- **Weight.** One full run builds the dashboard and website for production and bundles the API and worker; run one full verify per machine at a time.
- **OCR.** Without a local `tesseract` the scanned-invoice test is skipped, so a local green says nothing about OCR changes, while CI requires it. Install it (`brew install tesseract`) before trusting a local run on extraction work.
- **Service images.** MinIO images from quay.io and Docker Hub now refuse anonymous pulls; `ci-services.sh` pins Chainguard's MinIO by digest on purpose. Do not switch it back.

## Pointers

- `docs/development.md#release-verification`, `docs/development.md#stop-local-services`
- `scripts/verify/ci-services.sh`, `scripts/verify/lib.ts` (defaults for `VERIFY_*`), `scripts/verify/release.ts`
