# syntax=docker/dockerfile:1.7
# InvoiceWise production image: one image, two Kamal roles (config/deploy.yml).
#   web  - Next.js dashboard (apps/dashboard) on :3000, app.invoicewise.uk
#   api  - Bun API + workflow runner (apps/api) on :3003, api.invoicewise.uk;
#          applies database migrations before it starts serving.
# See docs/deployment.md.

ARG BUN_VERSION=1.3.13
ARG NODE_VERSION=22

FROM oven/bun:${BUN_VERSION}-slim AS bun

FROM node:${NODE_VERSION}-bookworm-slim AS base
# Bun runs the API, installs and the migrator; Node runs `next build`/`next start`.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY . .
RUN bun install --frozen-lockfile

# Public origins are compiled into the dashboard bundle.
ARG NEXT_PUBLIC_URL=https://app.invoicewise.uk
ARG NEXT_PUBLIC_API_URL=https://api.invoicewise.uk
ENV NEXT_PUBLIC_URL=${NEXT_PUBLIC_URL} \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# Build-time placeholders only: `next build` imports modules that read env at
# load time; nothing connects. Real values are injected by Kamal at run time.
RUN cd apps/dashboard \
  && DATABASE_PRIMARY_URL=postgresql://build:build@localhost:5432/build \
     BETTER_AUTH_SECRET=build-only-secret-not-used-at-runtime-000000 \
     BETTER_AUTH_URL=${NEXT_PUBLIC_URL} \
     STORAGE_BACKEND=local \
     LOCAL_STORAGE_PATH=/tmp/build-storage \
     STORAGE_SIGNING_SECRET=build-only \
     MIDDAY_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
     REDIS_URL=redis://localhost:6379 \
     SMTP_USER=build@invalid.test \
     SMTP_PASS=build-only \
     AUTH_EMAIL_FROM="Build <build@invalid.test>" \
     NODE_ENV=production \
     bun --no-env-file x next build

FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    TZ=UTC
COPY --from=build /app /app
RUN chmod +x /app/scripts/deploy/*.sh
