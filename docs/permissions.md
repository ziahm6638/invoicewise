# Workspace permissions

InvoiceWise has three workspace roles. Every product surface — dashboard,
tRPC, REST, API keys, OAuth grants, storage access and background jobs — is
expected to reach the same decision for the same actor.

## Role matrix

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| Read workspace, invoices, inbox, judgments, CSV exports, MCP, retention schedule | yes | yes | yes |
| Upload, process, retry, annotate invoices (including re-driving failed webhook deliveries, re-extracting, rerunning questions and correcting extracted fields, keeping a posted bill as it is) | yes | yes | yes |
| Re-post an invoice to the accounting provider (`POST /accounting/invoices/:id/retry`, and the accounting part of `inbox.retryDelivery` and `POST /invoices/:id/delivery/retry`, which report `admin_required` to a member), re-send it after a correction, or update a posted bill in place after a correction (`inbox.correct` with `update_bill`, refused to a member) | yes | yes | no |
| Manage workspace settings (name, logo, currency, email) | yes | yes | no |
| Invite, remove and re-role members | yes | yes, except owners | no |
| List and revoke pending invitations | yes | yes | no |
| Grant the `owner` role | yes | no | no |
| Manage custom questions | yes | yes | no |
| Correct supplier identity (reassign an invoice, merge suppliers, undo) | yes | yes | no |
| Manage integrations: API keys, OAuth apps, accounting, mailboxes, webhooks (endpoints, secret rotation, test events, per-endpoint redelivery), replacing the workspace's receiving address | yes | yes | no |
| Manage billing and subscription | yes | no | no |
| Export all workspace data ([data lifecycle](data-lifecycle.md)) | yes | no | no |
| Delete the workspace | yes | no | no |
| Transfer ownership | yes | no | no |

An owner cannot be removed or demoted by an admin. The last remaining owner
cannot leave, be removed or be demoted by anyone, including themselves, until
ownership is transferred.

## Where it is enforced

**One rule set.** `packages/db/src/queries/team-permissions.ts` holds the role
ranking, the capability helpers, the scope clamp and the transactional
primitives. Nothing else re-implements the matrix. Unknown, missing or
malformed roles and scopes rank below `member` and receive nothing.

**Database invariants.** `packages/db/src/queries/teams.ts` and
`packages/db/src/queries/user-invites.ts` perform membership mutations inside a
transaction that takes `SELECT … FOR UPDATE` on the team row first. The actor's
role, the target's role, the owner count and the write all happen under that
lock, so concurrent owner changes can never leave a workspace without an owner.
Removing a member (or the member leaving, or the workspace being deleted) moves
their active-team pointer and every session pointed at the workspace to another
workspace they still belong to, or clears them when none is left; removal, and
demotion to `member`, also deletes their API keys for it and revokes their
OAuth tokens. Removal and demotion also revoke the pending invitations they can
no longer grant (see **Invitations**).

**tRPC.** `protectedProcedure` resolves the caller's role from the primary
database on every request (`apps/api/src/trpc/middleware/team-permission.ts`).
`adminProcedure` and `ownerProcedure` in `apps/api/src/trpc/init.ts` gate the
privileged routers: team settings, members, invitations, questions, API keys,
OAuth applications, accounting and mailbox connections, and supplier
corrections (admin) and billing (owner). `workspaceProcedure` additionally requires an active workspace, so a
session with none cannot reach workspace-scoped handlers.

**Stale active workspace.** A browser session whose active-workspace pointer
names a workspace the user no longer belongs to is recovered on its next tRPC
or REST request rather than refused (`apps/api/src/utils/active-workspace.ts`,
`recoverActiveWorkspace` in `packages/db/src/queries/teams.ts`). Under the user
row lock the pointers move to the workspace the user last chose if still a
member, else their earliest membership, else none; with none the dashboard
routes to the workspace chooser and on to workspace creation. The request
continues in the recovered workspace, so nothing from the stale one is read,
and `user.me` only reports a stored workspace the user is a member of. API keys
and OAuth tokens stay bound to their workspace and are refused instead.

**REST.** `apps/api/src/rest/middleware/auth.ts` reads API keys, users and
membership from the primary database on every request, so deletion and
demotion take effect on the next call. Effective scopes are intersected with
what the caller's current role allows. `withRequiredTeamRole` guards the
privileged routes (team settings, accounting, webhooks), and `withRequiredTeam`
returns `403` for inbox, invoice, webhook and accounting routes when the caller
has no active workspace.

**API keys and OAuth grants.** Granting API access is the "manage
integrations" capability: creating a key, consenting to an OAuth application
(on either the tRPC or the REST consent endpoint) and refreshing an OAuth token
all require owner or admin in the workspace being granted, checked with
`canManageIntegrations` against the live role. A member is refused even for
scopes a member may hold, and the consent screen only offers workspaces where
`team.list` reports `permissions.manageIntegrations`. Scopes are also clamped
to the actor's role at each of those points. A key update is scoped by
`id AND team_id`, so an id from another workspace is never updateable.

The scope vocabulary is authoritative and lives in
`packages/db/src/utils/scopes.ts`. Aliases (`apis.all`, `apis.read`) are
expanded first, then intersected with the role: owners and admins may hold any
known scope, members keep invoice use (`inbox.read`, `inbox.write`) plus
`teams.read`/`users.read`, and any unknown scope is dropped for every role.
Consent decisions compare normalized sets rather than counts: an application
that registered `apis.all` covers a request for `inbox.read`, duplicates and
overlaps collapse, and a request containing anything the role cannot hold — or
anything unknown — is refused rather than silently downgraded.

**Credential tenant binding.** An API key or OAuth token is bound to the
workspace it was issued for. `/teams` returns only that workspace for a
credential, and detail, members and update requests for another workspace —
even one the same person belongs to — return 404. A browser session keeps the
deliberate multi-workspace behaviour.

**Profile reads.** `GET /users/me` and tRPC `user.me` return the account
profile and a workspace summary only. Workspace credentials such as the
receiving address come from workspace-scoped procedures (`inboundEmail.get`,
readable by every member; see [inbound email](inbound-email.md)).

**Mailbox OAuth connect.** `inboxAccounts.connect` (admin) issues a random
256-bit `state`, stores only its hash in `auth_verifications` bound to the
initiating user, workspace and browser session, and expires it after ten
minutes (`packages/db/src/queries/connector-state.ts`). The dashboard callback
passes it to `inboxAccounts.exchangeCodeForAccount`, which redeems it with one
conditional delete before any provider call, so a replayed, expired, forged or
foreign-session state is refused and a concurrent replay succeeds at most once.

**Redirects.** `checkout` and `checkout/success` pass the caller's
`redirectPath` through `safeRedirectPath`
(`apps/dashboard/src/utils/safe-redirect.ts`), which keeps only same-origin
relative paths and falls back to `/` for absolute, protocol-relative or
backslash targets; the kept path is resolved against the public app origin
(`getPublicUrl`), never the proxied request's internal origin.

**Invitations.** One flow, stored in `user_invites`: recipient email, status
and expiry are checked under the team lock at acceptance time, and the invite
row is deleted in the same transaction so it cannot be replayed. Invitations
are visible to a recipient only while they are `pending` and unexpired.

Invitations belong to the member who sent them, not to the workspace (#63).
When the sender leaves or is removed, every pending invitation they sent is
revoked; when the sender is demoted, their pending invitations for a role
above what their new role can grant are revoked (an owner demoted to admin
loses their owner invitations; anyone demoted to member loses all of them).
Revocation deletes the invite rows inside the same locked transaction as the
membership change (`revokeInvitesSentBy` in `user-invites.ts`), so a removed
or demoted member keeps no path back in through an invite to an address they
control. Acceptance independently re-checks, under the team lock, that the
sender is still a member who may grant the stored role, and refuses the invite
otherwise; revoked or cancelled invites cannot be accepted. Owners and admins
see the workspace's pending invitations, with sender and expiry, under
Settings → Members → Pending Invitations (`team.teamInvites`, admin and up) and
can revoke any of them (`team.deleteInvite`).

**Account deletion.** `deleteUser` takes the same team-row locks as every other
membership mutation. A user who is the sole owner of any workspace cannot
delete their account until ownership is transferred or the workspace is deleted
deliberately (a workspace only they belong to can be named back and deleted in
the same request), and deleting an account never deletes a shared workspace.
Workspace deletion is owner-only and requires the workspace name typed back;
both deletions queue a resumable cleanup of stored files and provider
connections. See [offboarding](offboarding.md).

Deletion locks the user row before it snapshots memberships, so a concurrent
workspace creation or invitation acceptance waits on that lock and then either
commits against a live user or fails and rolls back — it can never create a
workspace or membership around a user who is being deleted. Other flows take
the team lock before the user lock, so a deletion racing one of them can
deadlock; that is surfaced as a retryable `CONFLICT`, never a raw driver error.

**Billing endpoints.** `POST /api/checkout` and `GET /api/portal` on the
dashboard re-check the live owner role on the server before any Polar call, so
the dashboard and tRPC gates cannot be bypassed by calling the routes directly.

**Better Auth's native surface.** The organization plugin exposes a second
mutation surface for membership and invitations. Those endpoints cannot report
the acting user for every hook, so they are disabled in
`apps/api/src/auth.ts` and all membership changes go through the secured
workspace flows. Read endpoints and active-workspace switching
(`/organization/set-active`, `/organization/list`, session handling) are
untouched.

**Background jobs.** Jobs are enqueued server-side only after the role check
above, carry the workspace id in their payload, and re-scope every query by
that id. No job accepts a caller-supplied role.

## UI

The dashboard renders from a `permissions` object returned by `team.current`,
computed on the server from the same helpers. Hiding a control is a
convenience; the server re-checks every mutation, so a stale or tampered client
cannot escalate.

## Checks

`apps/api/src/trpc/routers/team.permissions.integration.test.ts` runs the
two-workspace, three-role matrix, member escalation attempts, native Better
Auth bypass attempts, removal and demotion revocation (including the
inviter-bound invitation rules and acceptance after revocation), key deletion,
cross-tenant key updates and concurrent owner changes against a disposable
Postgres database:

`apps/api/src/permissions.http.integration.test.ts` boots the real API app on a
local port and drives it over HTTP with real Better Auth session cookies, tRPC
and REST: three roles, workspace switching, member removal, workspace
deletion, credential tenant binding, the OAuth consent → token → refresh →
revoke flow, and account deletion. Providers are stubbed; nothing leaves the machine.

The HTTP suite also covers OAuth consent by role across two workspaces (a
member of one workspace is refused there but may grant as owner of their own),
refresh after demotion, the profile read carrying no workspace credential, and
the mailbox connect `state` (forged, foreign user, foreign session, replayed,
concurrent, expired and cross-workspace attempts are refused).

`apps/dashboard/src/app/api/billing-routes.test.ts` proves the checkout and
portal routes refuse members, admins and foreign workspaces before any provider
call, `apps/dashboard/src/app/api/checkout/success/route.test.ts` proves the
success redirect refuses absolute and protocol-relative targets, and `apps/dashboard/src/components/tables/members/permissions.test.ts`
proves the members-table controls follow the server matrix.

```bash
docker exec invoicewise-postgres-1 psql -U invoicewise -d postgres \
  -c "DROP DATABASE IF EXISTS invoicewise_perms_test" \
  -c "CREATE DATABASE invoicewise_perms_test"
cd packages/db && DATABASE_PRIMARY_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test bunx drizzle-kit migrate
cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
  bun test src/trpc/routers/team.permissions.integration.test.ts
cd apps/api && PERMISSIONS_TEST_DATABASE_URL=postgresql://invoicewise:invoicewise@localhost:5432/invoicewise_perms_test \
  bun test src/permissions.http.integration.test.ts
cd apps/dashboard && bun test src/app/api/billing-routes.test.ts src/app/api/checkout/success/route.test.ts \
  src/components/tables/members/permissions.test.ts
```

The suite skips itself when `PERMISSIONS_TEST_DATABASE_URL` is unset, so it can
never run against a development or production database by accident.

## Known limits

- Workspace-scoped procedures require an active workspace: a session with no
  active workspace gets `403` for them, while account, team-list, invitation
  and workspace-creation procedures keep working so the user can recover.
- Live visual QA of the dashboard role controls is still pending roadmap issue
  #61; this slice verifies them through the extracted members-table gating test,
  typecheck and a production build of the touched routes.
- Billing provider entitlements are not part of this matrix; roadmap issue #48
  owns plan limits.
