# Deployment

InvoiceWise runs on `hp-slice`, deployed with Kamal 2 from `config/deploy.yml`.
The marketing site at `invoicewise.uk` is a separate Vercel project and is not
deployed from this repository.

## Shape

```text
app.invoicewise.uk ─┐
api.invoicewise.uk ─┴─CNAME─▶ Cloudflare Tunnel 7a0344f4… (cloudflared on hp-slice)
                               ingress: both hostnames → http://localhost:3010
kamal-proxy (shared, 127.0.0.1:3010, TLS terminates at Cloudflare)
  ├─ invoicewise-web-<version>  Next.js dashboard, :3000, health /login
  │                             (serves Better Auth at /api/auth and uploads)
  ├─ invoicewise-api-<version>  Bun API + workflow runner, :3003, health /health
  │                             (applies migrations on boot, then serves)
  ├─ invoicewise-db             pgvector/pgvector:0.8.1-pg17, kamal network only,
  │                             data in /mnt/ssd/invoicewise/postgres
  └─ invoicewise-redis          redis:7.4-alpine, data in /mnt/ssd/invoicewise/redis
```

- Host: `hp-slice` (Tailscale `100.90.24.83`). Tailscale SSH as `root`.
- One image, two roles. The image is built on hp-slice (`builder.remote`) and
  moved through Kamal's local registry (`localhost:5555`, tunnelled over SSH),
  so no external registry or registry token is involved.
- Document storage is local (`STORAGE_BACKEND=local`) in
  `/mnt/ssd/invoicewise/storage`, mounted into both roles.
- Migrations: `scripts/deploy/api.sh` runs `drizzle-kit migrate` before the API
  starts. They are append-only and applied in one transaction; kamal-proxy only
  routes to the new API container once `/health` passes. The dashboard and API
  boot in that order (`web` first), so the dashboard of a release can briefly
  run against the previous schema: keep migrations additive.

## Secrets

Self-hosted Infisical at `infisical.zzapp.uk`, project `invoicewise`
(`.infisical.json`), environment `prod`. `.kamal/secrets` holds no values; every
line is `NAME=$NAME` from the environment `infisical run` injects.

| Key | Purpose |
| --- | --- |
| `DATABASE_PRIMARY_URL` | `postgresql://invoicewise:…@invoicewise-db:5432/invoicewise` |
| `POSTGRES_PASSWORD` | the database accessory's password (same as in the URL) |
| `BETTER_AUTH_SECRET` | session and token signing |
| `SMTP_PASS` | Purelymail password for `auth@invoicewise.uk` |
| `STORAGE_SIGNING_SECRET` | signed document links |
| `MIDDAY_ENCRYPTION_KEY` | 32-byte hex key for encrypted columns |

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `AUTH_EMAIL_FROM` are also stored in
Infisical for reference and are set in clear in `config/deploy.yml`.

Not yet configured, so the matching features stay off: `TYPESAFE_API_KEY`
(invoice extraction), Nango (accounting delivery), Gmail/Outlook OAuth
(mailbox connections), Polar (billing). Add the key to Infisical and to
`env.secret` in `config/deploy.yml` and `.kamal/secrets` to enable one.

## Mail

Transactional mail goes through Purelymail SMTP (`smtp.purelymail.com:465`) as
`auth@invoicewise.uk`, sender `InvoiceWise <auth@invoicewise.uk>`. The
`invoicewise.uk` domain's MX, SPF, DKIM and DMARC records point at Purelymail.

## Deploying

Prerequisites on the deploying machine: Docker running locally (for Kamal's
local registry), Kamal 2, the Infisical CLI logged in to
`https://infisical.zzapp.uk/api`, and Tailscale access to hp-slice.

From the repository root:

```bash
infisical run --env prod -- kamal deploy
```

First-time setup of a fresh host (accessories, proxy registration) is
`infisical run --env prod -- kamal setup`.

Useful:

```bash
infisical run --env prod -- kamal app logs -r api        # API and workflow logs
infisical run --env prod -- kamal app logs -r web        # dashboard logs
infisical run --env prod -- kamal accessory logs db
infisical run --env prod -- kamal rollback <version>
infisical run --env prod -- kamal app stop               # kill switch
```

## Tunnel and DNS

`/root/.cloudflared/config.yml` on hp-slice routes `app.invoicewise.uk` and
`api.invoicewise.uk` to `http://localhost:3010` (edit it, run
`cloudflared tunnel ingress validate`, then `systemctl restart cloudflared`).
Both hostnames are proxied CNAMEs to
`7a0344f4-eee4-4222-acc7-b884164dd249.cfargotunnel.com` in the `invoicewise.uk`
Cloudflare zone.
