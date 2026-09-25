# Offboarding and deletion

Removing a person and deleting a workspace are separate operations. Deleting
an account never deletes a workspace that other members still use, and a
workspace is deleted only when its owner asks for it by name.

| Operation | Who | What is removed at once | Workspace |
| --- | --- | --- | --- |
| Leave / remove member | the member, or an owner/admin (see [permissions](permissions.md)) | the membership, the member's API keys and OAuth tokens for the workspace, their pending invites; sessions move to another workspace | kept |
| Transfer ownership | an owner (Settings → Members, change a member's role to owner) | nothing | kept |
| Delete account (`user.delete`) | the person | their user row, sessions, memberships, API keys and OAuth tokens | shared workspaces are kept; a sole-owned workspace nobody else belongs to is deleted only if named back in the same request |
| Delete workspace (`team.delete`) | an owner only, typing the workspace name | every row of the workspace; members' sessions move to another workspace | deleted |

## Account deletion

`deleteUser` (`packages/db/src/queries/users.ts`) locks the person's user row
and every workspace they belong to, then counts **all** owners and members of
each workspace, not only the person's own membership. A workspace the person is
the only owner of blocks the deletion:

- **Shared** (other members): the request is refused with `CONFLICT`; they must
  transfer ownership to another member, or delete that workspace, first.
- **Unshared** (they are its only member): it is deleted in the same
  transaction, exactly as workspace deletion below, when the request lists it
  in `deleteWorkspaces` with its name typed back (`confirmName`, as for
  `team.delete`). Unlisted, the request is refused with `CONFLICT`; a wrong
  name, or a listed workspace they do not solely own, with `BAD_REQUEST`.

`user.soleOwnedWorkspaces` lists these workspaces, so Account → Delete account
asks for each unshared workspace's name next to `DELETE`, and names the shared
ones that need a transfer. Once nothing blocks, the user row is deleted;
memberships, sessions, API keys and OAuth tokens cascade with it, and the
remaining workspaces, their invoices and the other members' access are
unchanged. Someone with no workspace left (for example after deleting their
last one) cannot open account settings, so workspace creation (`/teams/create`)
also offers account deletion.

The person's own private objects (their avatar, under `vault/<user id>/`) are
purged by the cleanup below.

## Workspace deletion

`deleteTeam` (`packages/db/src/queries/teams.ts`) is owner-only and requires
`confirmName` to equal the workspace name (surrounding spaces ignored, case
sensitive; `DELETE` for a workspace without a name). The dashboard asks for the
same text. In one transaction it:

1. moves every member's stored and session active-workspace pointer to another
   workspace they belong to (or none);
2. snapshots the live provider connections (Xero/QuickBooks through Nango,
   Gmail/Outlook mailboxes);
3. deletes the team row. Everything that names the workspace cascades with it:
   memberships, invitations, API keys, OAuth tokens, mailbox and accounting
   connection records, invoices, questions, webhooks, data export requests and
   **queued or retrying workflow jobs** (including export builds);
4. records a `deletion_requests` row and queues its `purge-deleted-data` job.

With the team row gone, a late writer cannot recreate data: a job that was
already running, a provider callback or an incoming email fails on the missing
workspace (foreign key or workspace lookup), and API keys and sessions no
longer resolve to it. `apps/api/src/trpc/routers/team.offboarding.integration.test.ts`
checks that no table with a `team_id` column keeps a row for the deleted
workspace.

## Resumable cleanup

What lives outside the primary database is finished by the `purge-deleted-data`
workflow (`packages/jobs/src/deletion.ts`), driven by the durable
`deletion_requests` row, which has no foreign key to the subject so it outlives
it:

1. **Revoke connections.** Each Nango connection is deleted (a connection Nango
   no longer has counts as revoked). A Gmail grant is revoked at Google. Outlook
   has no per-token revocation, so destroying the stored tokens (step 3 above)
   is the revocation. Each success is recorded before the next starts, and a
   revoked mailbox's captured token is dropped.
2. **Purge private objects** under `vault/<subject id>/` (invoice files, logos,
   avatars, data export archives), in the local or S3/R2 backend. This waits until `quiesce_until`:
   ten minutes after the deletion and after the lease of any job that was
   running for the workspace, so an in-flight writer cannot leave an object
   behind the purge. An early run schedules itself for that time instead of
   spending a retry.
3. **Complete.** The request keeps only ids and timestamps; connection
   references are cleared. The request never stores the workspace name.

A run that fails or is interrupted leaves the progress on the request, so the
next run resumes where it stopped: a revoked connection is not revoked twice
and a purged prefix is not purged again. Each run increments `attempts` and
stores `last_error`; the job retries with backoff up to 8 attempts.

### When cleanup fails

- `bun jobs:status` lists the unfinished requests among the 50 most recent,
  with their progress and last error. Failed runs also log
  `deletion_cleanup_failed`.
- When the job gives up, the request is marked `failed`; it is never deleted.
- Fix the cause (provider credentials, storage access), then run
  `bun jobs:resume-deletions`. It re-queues every `pending` or `failed` request
  without a live job and leaves the others alone, so it is safe to repeat.

## Backups and retention

Deletion removes data from the **live** systems: the primary database at once,
and stored files and provider connections through the cleanup above, normally
within minutes.

It does not rewrite backups, and nobody should promise instant removal from
them. In production (see [deployment](deployment.md#backups)) the nightly
`invoicewise-backup` dumps of the `invoicewise` and `nango` databases are kept
for the operating backup period (30 days; see
[data lifecycle](data-lifecycle.md#retention-schedule)), so a deleted account's
or workspace's rows, and the encrypted credentials of its Nango connections,
remain in dumps taken before the deletion until those dumps age out: at most
about 31 days after the deletion. Document files and export archives are not in
these dumps, so the object purge is final. Any other copy an
operator keeps (disk snapshots, copies of the dumps) follows its own retention.

A restore brings deleted subjects back. After restoring a dump, re-delete every
account and workspace whose deletion was requested after the dump was taken;
save the live `deletion_requests` rows before restoring, because they list
them. A completed request is kept for the backup period after it completes and
then removed by the retention job, so every dump still on disk is covered.

## Known limits

- Deleting a workspace does not cancel a Polar subscription; cancel it in
  billing first.
- A Nango connection whose connect flow finishes after the workspace was
  deleted is refused by the API but is not revoked at Nango automatically.
