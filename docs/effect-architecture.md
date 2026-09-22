# Effect architecture

InvoiceWise product code should be implemented as Effect services and assembled
with `Layer`. Migration is incremental: inherited Hono and tRPC surfaces remain
available until their product paths are converted.

## Proven slice

The REST invoice read path is the reference implementation:

- `GET /inbox`
- `GET /inbox/:id`
- `POST /inbox/:id/presigned-url`

`apps/api/src/effect/invoice-read.ts` contains the schemas, tagged errors,
service tags, and layers. `apps/api/src/effect/invoice-http.ts` declares the
`HttpApi` and connects handlers to the service. The API process is owned by
Effect's Bun `HttpServer`; unmatched and unconverted traffic is passed to the
existing Hono app. For now Hono still performs authentication, scope checks,
and rate limiting before these three handlers are forwarded to `HttpApi`. That
keeps the auth replacement lane independent.

The forwarding adapter overwrites the internal team header after authentication.
Do not expose the invoice `HttpApi` handler directly until an Effect auth
middleware provides the same trusted team context.

## Service pattern

Define domain operations on a `Context.Tag`, then implement a layer from its
smallest infrastructure dependencies:

```ts
class InvoiceRead extends Context.Tag("invoicewise/InvoiceRead")<
  InvoiceRead,
  {
    readonly findById: (
      id: string,
      teamId: string,
    ) => Effect.Effect<InvoiceItem, InvoiceNotFound | InvoiceReadError>;
  }
>() {}

const InvoiceReadLayer = Layer.effect(
  InvoiceRead,
  Effect.gen(function* () {
    const repository = yield* InvoiceRepository;
    return {
      findById: (id, teamId) => repository.findById(id, teamId),
    };
  }),
);
```

Keep live wiring separate from the service layer so tests can provide a small
fake layer. Do not read `process.env` inside domain services. Live layers load
configuration with `Config`; secrets and connection strings use
`Config.redacted`.

## Errors and HTTP

Expected failures are `Schema.TaggedError` values in the Effect error channel.
Add them to `HttpApiEndpoint` with the intended status code. Promise rejection
and schema-validation failures are translated once at the infrastructure
boundary into a domain error such as `InvoiceReadError`; domain code does not
throw strings.

The Drizzle client remains in `@invoicewise/db`. Its Effect layer uses
`Layer.scoped` and closes all pools when the API scope ends. The local storage
client is stateless and is acquired through a config-backed `Layer.effect`.
The inherited singleton database used by unconverted Hono and tRPC routes is
also closed by the Effect server's shutdown scope.

## Tests

Unit and HTTP tests provide `Layer.succeed` implementations for repositories
or external clients, then exercise the real service or `HttpApi` handler. The
reference test is `apps/api/src/effect/invoice-read.test.ts`:

```bash
cd apps/api
bun test src/effect/invoice-read.test.ts
```

Use live Postgres only for the local-stack acceptance check, not for routine
domain tests.

## Migration ledger

Now Effect:

- Bun HTTP server lifecycle and API port/origin config
- REST invoice list, detail, and attachment URL behavior
- Drizzle and storage injection for that slice
- typed errors and schema-driven request/response handling for that slice
- Postgres-backed workflow queue, leases, retries, concurrency, idempotency, and
  structured run logs
- invoice attachment processing, inbox-provider sync, team invitations, and
  onboarding workflows

Still inherited:

- Hono authentication, scopes, rate limiting, storage-file serving, health,
  OAuth, teams, and users routes
- all tRPC routers, including the dashboard's current inbox transport
- unconverted package-level async functions

Convert next in dependency order: delivery integrations/webhooks, then the
remaining REST/tRPC endpoints. Move authentication into Effect only after the
parallel auth lane establishes its replacement contract.
