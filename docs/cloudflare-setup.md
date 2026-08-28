# Cloudflare setup

The Workers are created by `wrangler deploy` from this repository. Do not create a competing dashboard Worker or Git-connected build pipeline. Keep binding IDs and public config in the committed `wrangler.toml`; keep tokens and Worker secrets out of git.

## CI API token

Create an API token scoped to the one intended Cloudflare account. Cloudflare's dashboard calls
write-capable grants **Edit**, while the API reference may call the same authority **Write**; these
are not two separate grants.

| Scope                              | Permission                      | Purpose                                                                                         |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| Exact account                      | Workers Scripts — Edit/Write    | Deploy, list, and delete both Workers, and read the account Workers subdomain                   |
| Exact account                      | D1 — Edit                       | Exact-name database list/create, migrations, and delete                                         |
| Exact account                      | Workers R2 Storage — Edit/Write | Exact-name bucket list/create, object list/delete, and bucket delete                            |
| Exact production zone, conditional | Workers Routes — Edit/Write     | Only when this same token also deploys the committed long-lived production custom-domain routes |

Generated pull-request configs have no routes, so Workers Routes authority is not a PR-preview
requirement. Do not grant all accounts, all zones, or a Global API Key where the exact account and
zone can be selected. Do not add **Account Settings — Read**: the current
[Workers subdomain endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/)
accepts Workers Scripts Read or Write, and the token already needs write authority. See
[Cloudflare's API token permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
for the current permission names.

Set the two repository secrets and the non-secret Workers-subdomain variable without placing
literal values in documentation or git:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh variable set CF_WORKERS_SUBDOMAIN --body '<account-workers-subdomain>'
```

`CF_WORKERS_SUBDOMAIN` is the single account label (for example, `team-name`), not a URL and not a
value ending in `.workers.dev`. When it is absent, the preview resource helper can query the
account subdomain endpoint using Workers Scripts authority, but set the variable before the first
live proof so provisioning does not depend on discovery. The preview workflows deliberately
self-skip green while either secret is absent. Fork PRs skip before any secret-bearing step.
Optional `STASH_SMOKE_BASE_URL` and `VIEWER_SMOKE_BASE_URL` variables enable the existing
post-deploy production smoke URLs; they are not PR-preview prerequisites.

## Pull-request previews

Once the repository configuration above exists, a same-repository PR `N` targeting `main` or
`base/**` receives the following isolated resources. Operators do not precreate them.

| Resource             | Exact identity                                                               |
| -------------------- | ---------------------------------------------------------------------------- |
| Stash Worker         | `zudo-history-stash-pr-N`                                                    |
| Viewer Worker        | `zudo-history-stash-viewer-pr-N`                                             |
| D1 database (`DB`)   | `zudo-history-stash-pr-N`                                                    |
| Private R2 (`BLOBS`) | `zudo-history-stash-blobs-pr-N`                                              |
| Durable Object       | Unchanged `StashEvents` class; namespace owned by the PR stash Worker script |
| Stash origin         | `https://zudo-history-stash-pr-N.<CF_WORKERS_SUBDOMAIN>.workers.dev`         |
| Viewer origin        | `https://zudo-history-stash-viewer-pr-N.<CF_WORKERS_SUBDOMAIN>.workers.dev`  |

These disposable resources are distinct from the committed, long-lived production and
`env.preview` resources documented in [D1 provisioning](#d1-provisioning),
[Live-event Durable Object](#live-event-durable-object), and [R2 provisioning](#r2-provisioning).
Never point a PR at `zudo-history-stash-preview` or `zudo-history-stash-blobs-preview`.

`scripts/preview-config.mjs` starts from each committed `[env.preview]` table, validates its
supported shape, and writes a flattened top-level config. It rewrites the Worker names and D1/R2
and service bindings, preserves the required vars, secrets, rate limits, Durable Object binding and
migration, and rebases entry, asset, and D1 migration paths. It forces `workers_dev = true`, removes
routes and Cloudflare version-preview settings, and sets every application cron to `[]`. The
generated files therefore deploy directly with `-c <generated-config>`; do not add
`--env preview`. These are ordinary separate `.workers.dev` Workers, not Cloudflare version
**Preview URLs**.

The generated rate-limit namespace is account-wide and reserves ten IDs per PR:

```text
String(2_000_000 + N * 10 + zeroBasedBindingIndex)
```

The current `RL_READ`, `RL_WRITE`, and `RL_DIFF` bindings use indexes `0`, `1`, and `2`; indexes
`3..9` stay reserved for that PR. The generator rejects more than ten bindings and any unsafe
integer allocation. This range remains disjoint from the committed production and static-preview
IDs in [Rate-limiting namespaces](#rate-limiting-namespaces).

### Deploy and credentials

The `preview.yml` workflow handles same-repository `opened`, `synchronize`, and `reopened` events.
It never uses `pull_request_target`; a fork or missing Cloudflare configuration is an explicit
green skip. For an eligible PR, it:

1. reuses or creates the exact D1 database and R2 bucket;
2. generates the flattened configs, builds the packages and Viewer, and migrates the PR database;
3. supplies a generated admin secret in the stash's first upload, deploys the Viewer, and waits for
   health through the Viewer proxy;
4. seeds `demo` through the proxy with `seed-dev --ci`, runs the preview-tier read contract and
   strict HTTP smoke, then runs the explicit `chromium-preview`/`@preview` browser project; and
5. mints a stash-scoped read token and creates or updates exactly one `<!-- zhs-preview -->`
   comment with both URLs and the deployed SHA.

The generated admin token is masked and remains private state, never a job output, comment, or
artifact. `seed-dev --ci` suppresses the generated write token. The marker contains only the
disposable `demo` stash's generated read token, which is masked in logs while passed between steps.
A later `synchronize` event reuses the exact D1, R2, and marker comment for that PR instead of
creating duplicates. See
[the pull-request preview testing lane](../TESTING.md#pull-request-preview-lane) for the read-only
evidence boundary.

### Teardown, retry, and reaper

Closing an eligible PR automatically runs one authoritative, verified sequence:

```text
Viewer Worker -> stash Worker/owned DO namespace -> empty R2 -> delete R2 -> delete D1 -> mark comment torn down
```

Deploy and close teardown share the same per-PR concurrency key, so close cancels an in-flight
same-PR deployment. Cleanup tolerates only structured, verified absence; it does not use a blanket
best-effort delete. The final comment body contains neither URLs nor the read token.

If a closed-PR teardown is interrupted, retry the complete workflow rather than calling the
storage-only helper:

```bash
gh workflow run preview-teardown.yml --ref main -f pr=N
```

The manual path validates that the exact PR is closed and refuses an open, missing, or malformed
PR before Cloudflare mutation. `preview:resources teardown` alone cannot delete the Workers or
their owned Durable Object namespace and cannot sanitize the marker comment.

A weekly reaper covers resources left by failed or cancelled runs and may also be dispatched
manually:

```bash
gh workflow run preview-reaper.yml --ref main
```

It unions exact PR-number inventory from every Worker, D1, and R2 page, then checks the GitHub PR
state after acquiring that PR's concurrency fence. Open PRs are retained; closed-PR resources use
the same teardown helper, and each candidate reports a retained, cleaned, or failed result. Unlike
close/manual teardown, the reaper reports only and never edits the PR marker comment. PR Workers
intentionally have no **application GC cron**; close teardown and the reaper separately own the
**preview resource lifecycle**. Inspect failed cleanup runs and retry them rather than assuming
immediate cleanup.

### Capacity and usage

Preview resources multiply with the number of open PRs and share account/plan limits:

- Each PR uses two Worker scripts. Concurrent previews can exhaust the account's current
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- Each PR creates one D1 database. D1 query compute scales to zero, but rows, storage, and
  operations aggregate across the account until teardown; consult current
  [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
- Each PR creates one Standard R2 bucket. Stored bytes and Class A/B operations, including
  lifecycle list/delete work, aggregate across the account; consult current
  [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
- Each PR stash Worker owns a SQLite-backed `StashEvents` namespace. The class stores no
  application data, but its HTTP SSE response deliberately does not hibernate while connected, so
  requests and active duration can accrue; consult current
  [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Automatic close teardown and the weekly reaper reduce orphan lifetime; they do not promise zero
usage, zero cost, or instant cleanup while GitHub Actions or Cloudflare is unavailable.

## D1 provisioning

Create the long-lived production and static-preview databases, decline Wrangler's offer to edit
the config automatically, and paste the printed IDs into the committed
`workers/stash/wrangler.toml` bindings:

```bash
pnpm exec wrangler d1 create zudo-history-stash
pnpm exec wrangler d1 create zudo-history-stash-preview
```

The long-lived deployment workflows remain skipped until the Cloudflare credentials and committed
D1 IDs are ready. Apply migrations from `workers/stash` with
`pnpm exec wrangler d1 migrations apply zudo-history-stash --remote` before deploying code.

These two databases belong only to the committed default and `env.preview` environments.
Pull-request workflows create and discover their own exact `zudo-history-stash-pr-N` database; do
not precreate it or reuse the static-preview database for a PR.

## Live-event Durable Object

`StashEvents` is a SQLite-backed Durable Object class. Keep both of these entries in the default
stash Worker configuration and repeat them under `env.preview`; Wrangler environments do not
inherit Durable Object bindings or migrations:

```toml
[[durable_objects.bindings]]
name = "STASH_EVENTS"
class_name = "StashEvents"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StashEvents"]
```

The long-lived static-preview equivalents are `[[env.preview.durable_objects.bindings]]` and
`[[env.preview.migrations]]`. The `v1` migration creates the Durable Object namespace on the first
deployment of each environment; it is distinct from the D1 SQL migrations above. Keep the tag and
class history stable after deployment, and validate both configurations before release:

```bash
pnpm --filter zudo-history-stash exec wrangler deploy --dry-run --env=""
pnpm --filter zudo-history-stash exec wrangler deploy --dry-run --env=preview
```

[SQLite-backed Durable Objects are available on Workers Free](https://developers.cloudflare.com/durable-objects/platform/pricing/),
subject to that plan's current limits. This class intentionally stores no application data, but
its SSE delivery model is not hibernating: Cloudflare keeps a Durable Object active while an HTTP
response stream is in flight. The shared heartbeat and per-subscriber lifetime timers therefore
contribute active duration while viewers remain connected. Five-minute stream rotation bounds
authorization staleness; an immediately reconnecting viewer can still keep the object active
continuously. Consult the current [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
and [wall-time limits](https://developers.cloudflare.com/durable-objects/platform/limits/) rather
than relying on a fixed price estimate.

`STASH_EVENTS_MAX_STREAM_MS` is `"300000"` in both default and preview variables. A stash token's
effective connection lifetime is the smaller of that configured maximum and its remaining token
lifetime; administrators and non-expiring stash tokens use the configured maximum. Revocation,
expiry, or stash deletion takes effect no later than the current effective lifetime. Each reconnect
re-runs authorization, so a revoked or expired credential and a deleted stash fail before a new
stream opens. This is a bounded revocation SLA, not an immediate-disconnect promise.

## Stash lifecycle and garbage collection

The committed Worker variables define the lifecycle and garbage-collection policy used by this
Worker:

Deleted stashes remain retained rows; `STASH_DELETE_GRACE_DAYS` controls their restore window and
does not authorize hard-purging them.

| Variable                  | Production and preview value | Purpose                                                              |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `STASH_DELETE_GRACE_DAYS` | `"30"`                       | Restore window for deleted stashes                                   |
| `GC_ORPHAN_MIN_AGE_MS`    | `"900000"`                   | Minimum age for an orphaned R2 object to become eligible for cleanup |
| `GC_LEASE_TTL_MS`         | `"300000"`                   | Lease duration for a fenced GC run                                   |

Keep the same values in the root `[vars]` and `[env.preview.vars]` sections of
`workers/stash/wrangler.toml`.

GC is an administrator-only, resumable operation. For a safe inspection, run one dry page first:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $STASH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"kind":"r2-orphans","dryRun":true,"maxObjects":80}' \
  https://stash.example.com/v1/admin/gc
```

The R2 orphan engine scans at most 24 objects per page, even when a larger `maxObjects` value is
requested. Ledger pages accept at most 500 rows. The scheduled invocation requests 80 objects,
alternates `r2-orphans` and `ledger` for a fair first attempt, shares one 45-operation storage
budget across both kinds, and stops before an unsafe page. It runs no more than ten pages per kind
per invocation. A returned cursor is opaque and must be passed unchanged; `cursor: null` means the
current pass is complete. A live lease returns `409 gc-busy`. If a deployment or operator stops a
page, resume by invoking the same kind without a cursor (the stored cursor is used), or pass the
last returned cursor explicitly when recovering a known page. Never copy R2 keys or generations
from logs or storage into an operator-facing record.

Every page creates a run record with a per-page UUID, stable kind/job ID, counters, timestamps,
opaque cursor, and nullable error. `GET /v1/admin/gc/runs` lists recent records newest first;
history retains the newest 500 records per kind. Dry runs acquire a lease and create a run record
but do not delete R2 objects, delete ledger rows, or persist a cursor.

Production application GC runs at `17 3 * * *` (UTC). The committed static-preview environment and
generated PR Workers explicitly have no application GC cron. PR close teardown and the weekly
GitHub reaper still own the separate [preview resource lifecycle](#teardown-retry-and-reaper), so
absence of an application cron does not mean manual-only cleanup. Deploy v2 writers and the
migration first, then the API and its route tests, verify a dry run and recovery path, and
enable/deploy the production cron last. This order prevents a scheduler from interpreting data
before the generation-aware writers, schema, and API are ready.

## R2 provisioning

Create separate long-lived production and static-preview buckets. Their names already match the
committed `BLOBS` bindings in `workers/stash/wrangler.toml`:

```bash
pnpm exec wrangler r2 bucket create zudo-history-stash-blobs
pnpm exec wrangler r2 bucket create zudo-history-stash-blobs-preview
```

Keep both buckets private. Do not enable an `r2.dev` URL or attach a custom domain; the stash
Worker accesses objects only through its R2 binding.

Pull-request workflows create a separate private `zudo-history-stash-blobs-pr-N` bucket and empty
it before teardown. Do not precreate a PR bucket or point it at
`zudo-history-stash-blobs-preview`.

Spilled blob rows created before the R2 generation rollout continue to read their exact legacy
keys (`<stash>/sha256-<64 lowercase hex>`). New uploads write only generation-scoped keys
(`v2/<stash>/<sha256-hash>/<lowercase UUID>`). Each upload attempt gets a fresh generation, so a
concurrent or retried write cannot overwrite another attempt's object. Deploy the new Worker before
introducing any lifecycle or garbage-collection process that interprets these formats; no data
migration is required for legacy reads.

## Rate-limiting namespaces

The stash Worker uses Cloudflare Rate Limiting bindings for three capability buckets. Namespace IDs
are account-wide: bindings with the same ID share counters, even across Workers. Keep production and
preview on the committed, disjoint allocation below.

| Binding    | Capability | Limit per location | Production namespace | Preview namespace |
| ---------- | ---------- | ------------------ | -------------------- | ----------------- |
| `RL_READ`  | Reads      | 600 per 60 seconds | `1101`               | `1201`            |
| `RL_WRITE` | Writes     | 60 per 60 seconds  | `1102`               | `1202`            |
| `RL_DIFF`  | Diffs      | 120 per 60 seconds | `1103`               | `1203`            |

The platform counters are per Cloudflare location, permissive, and eventually consistent. The API
therefore guarantees only that a limiter result of `{ success: false }` produces a `429` response
with `Retry-After: 60`; it does not promise an exact global cutoff. Administrator requests bypass
the bindings, and a binding exception fails open with a structured warning so a limiter outage does
not take the stash API down.

Generated PR configs use the ten-ID allocation documented under
[Pull-request previews](#pull-request-previews):
`String(2_000_000 + N * 10 + zeroBasedBindingIndex)`. The current bindings consume `0..2`, and
`3..9` remain reserved for that PR. Keep this account-wide range disjoint from both committed
columns above.

## Worker secret and viewer access

Set the admin credential locally or remotely; the value is never committed:

```bash
pnpm exec wrangler secret put STASH_ADMIN_TOKEN
```

For local development, put the corresponding value in `workers/stash/.dev.vars` (copy the example
file). Put Cloudflare Access in front of the viewer hostname when it is exposed to operators; the
viewer itself holds no stash secret and only receives the token pasted into its login screen.

The committed `preview_urls` setting concerns Cloudflare version Preview URLs. The repository's
pull-request previews are separate Workers with `workers_dev = true`, generated PR-specific
service bindings, no routes, and no version-preview setting; do not point them at
`zudo-history-stash-preview`.

See [README.md](../README.md) for local commands and [the Cloudflare deploy-from-zero guidance](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/main/src/content/docs/workers/deploy-from-zero.mdx) for provisioning pitfalls.
