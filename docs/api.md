# API reference

History Stash exposes a JSON API under `/v1`. The public client package,
`@takazudo/zudo-history-stash`, is the preferred interface for Node.js, browser, and Cloudflare
Workers consumers. Direct HTTP callers can use the same contract documented here.

Examples use `https://stash.example.com` as the public Worker origin, `demo` as the stash name,
and `docs/guide.md` as the file path. File paths are ASCII segments made from letters, numbers,
`.`, `_`, and `-`, joined by `/`; they are sent without percent-encoding.

## OpenAPI

The machine-readable [OpenAPI 3.1 document](openapi.json) is generated from the route list,
route contracts, and response schemas. Regenerate it with:

```bash
pnpm openapi:generate
```

Do not hand-edit `docs/openapi.json`; regenerate it and commit the resulting file. Operations
whose route contains `*path` use a wildcard `{path}` parameter in the document. OpenAPI 3.1 path
templating does not permit unescaped slashes in that value, so generated clients must not be
assumed to work for wildcard operations.

## Authentication and principals

Except for health, requests carry one bearer credential:

```http
Authorization: Bearer <token>
```

- The `STASH_ADMIN_TOKEN` secret is the administrator credential.
- A stash token starts with `zhs_`, belongs to one stash, and has `read` or `write` scope.
- `write` scope includes read access. A token for another stash receives `404`, not `403`, so
  stash existence is not disclosed.
- A token can expire at an ISO timestamp; `expiresAt: null` means it never expires. A missing,
  malformed, revoked, expired, or duplicated `Authorization` header receives the same `401`, so
  token existence is not disclosed. A token that expires during a request remains valid for that
  request.

The route table uses these principal labels:

| Principal        | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| `open`           | No credential required                                 |
| `any`            | Any valid administrator or stash credential            |
| `admin`          | Administrator only                                     |
| `admin-or-stash` | Administrator or a token belonging to `:stash`         |
| `read`           | Administrator or a matching `read`/`write` stash token |
| `write`          | Administrator or a matching `write` stash token        |

## Errors

An expected failure is JSON. Conflicts can also include the current head at the root:

```json
{
  "error": { "code": "stale", "message": "Expected version is stale" },
  "current": {
    "version": 7,
    "hash": "sha256-0000000000000000000000000000000000000000000000000000000000000000",
    "deleted": false,
    "kind": "put",
    "author": "bot",
    "createdAt": "2026-08-25T12:00:00.000Z"
  }
}
```

| HTTP  | Codes                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `400` | `validation`, `invalid-path`, `body-not-well-formed`                                                                       |
| `401` | `unauthorized`                                                                                                             |
| `403` | `scope`                                                                                                                    |
| `404` | `not-found`, `file-deleted`, `version-not-found`                                                                           |
| `409` | `stale`, `exists`, `already-deleted`, `gc-busy`, `already-rotated`, `token-expired`, `proposal-expired`, `proposal-closed` |
| `413` | `payload-too-large`                                                                                                        |
| `422` | `idempotency-key-reused`, `rollback-target-tombstone`                                                                      |
| `429` | `rate-limited`                                                                                                             |
| `500` | `internal`                                                                                                                 |

Unknown JSON keys are rejected. Request bodies are never echoed in errors. All timestamps in
responses are ISO-8601 UTC strings; imported `createdAt` values are epoch milliseconds.
An `already-rotated` error carries the winning successor token ID as
`error.successorId`; it never carries the one-time successor secret.

## Limits and storage tiers

A text body is limited to **5 MB (5,000,000 UTF-8 bytes)**. The boundary is inclusive and applies
to a file PUT, each `put` version in an import, and a diff candidate. The whole encoded HTTP
request is limited to **32 MiB (33,554,432 bytes)**, including JSON structure and escaping. A
request strictly above that aggregate limit receives `413 payload-too-large` before
authentication or any D1 or R2 access. Imports still contain at most 20 versions, but the encoded
request limit can require fewer versions per call.

Text bodies of at most **524,288 bytes** are stored inline in D1. Larger file and proposal
candidate bodies are stored in private R2 under content-addressed keys; D1 retains the
authoritative metadata, hash, size, file head or proposal reference, history, and pointer. Reads
verify the R2 object's raw byte size and SHA-256 hash before a fatal, BOM-preserving UTF-8 decode.
Responses never expose the private object key. Diffing remains limited to 524,288 bytes per side,
so equal-hash and oversized results use metadata without loading R2 bodies. A proposal candidate
is referenced through its blob row as soon as it is created, so a successfully stored proposal is
not an R2 orphan.

Compare-and-set eligibility is checked before upload. An eligible large write uploads to R2 before
the fenced D1 commit; a race or other refusal after upload can therefore leave an unreferenced
private content-addressed orphan for future garbage collection (future GC). The orphan is not
reachable through the API.

## Rate limits

Routes reachable by stash principals use three Cloudflare rate-limit buckets. `RL_READ` permits
600 operations per 60 seconds, `RL_WRITE` permits 60 per 60 seconds, and `RL_DIFF` permits 120 per
60 seconds. Stored, candidate, and proposal diff routes use `RL_DIFF`; write-capability file
routes plus proposal create/approve/reject use `RL_WRITE`; `/v1/me`, stash metadata, file
reads/lists/history, proposal list/get, the per-stash change feed, and each live-events connection
use `RL_READ`.

Each request checks `p:<tokenId>` first and then `s:<principal-stash>`. Lifecycle routes and
`POST /v1/admin/gc` use the write class; `GET /v1/admin/gc/runs` uses the read class. A failed principal check
short-circuits before the stash bucket is consulted. The administrator is exempt, so
administrator-only token-management routes are intentionally not rate-limited. Cloudflare limits
are per location and eventually consistent; the contract does not promise an exact global cutoff.
A limiter binding exception fails open and is logged rather than taking the API down.

When a binding reports `{ success: false }`, the response is
`429 { "error": { "code": "rate-limited", "message": "…" } }` with `Retry-After: 60`.
No file, version, blob, or idempotency mutation occurs, though authentication may already have
updated the token's `lastUsedAt` audit field.

## Quick examples

### curl

```bash
curl --fail-with-body https://stash.example.com/v1/health

curl --fail-with-body \
  -H "Authorization: Bearer $STASH_TOKEN" \
  https://stash.example.com/v1/stashes/demo/files/docs/guide.md

curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $STASH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: job-42-docs-guide" \
  --data '{"body":"Hello\n","expectedVersion":3,"author":"docs-bot"}' \
  https://stash.example.com/v1/stashes/demo/files/docs/guide.md
```

### Node.js client

```ts
import { createStashClient } from "@takazudo/zudo-history-stash";

const client = createStashClient({
  baseUrl: "https://stash.example.com",
  token: process.env.STASH_TOKEN,
});

const result = await client.files("demo").history("docs/guide.md", { limit: 20 });
if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
console.log(result.value.versions);
```

Business failures (`400`–`499`) are returned as `{ ok: false, error, current? }`. Network errors
and `500` responses throw `StashHttpError`.

### Cloudflare Worker service binding

Declare the binding on the consumer Worker:

```toml
[[services]]
binding = "STASH"
service = "zudo-history-stash"
```

Then pass the binding's HTTP interface to the client. The hostname is inert; the service binding
delivers the request directly to the stash Worker, and authentication is still required.

```ts
import { createStashClient } from "@takazudo/zudo-history-stash";

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const client = createStashClient({
      baseUrl: "https://stash.internal",
      token: env.STASH_TOKEN,
      fetch: (input, init) => env.STASH.fetch(input, init),
    });
    const result = await client.files("demo").get("docs/guide.md");
    return Response.json(result);
  },
};
```

Cloudflare documents that HTTP service bindings accept a `Request` and return a `Response`; calls
must be awaited so the downstream Worker is not terminated early.

### Cloudflare Worker RPC binding

For a same-account consumer Worker, a named `StashRpc` entrypoint is the recommended binding. Set
`compatibility_date` to `2024-04-03` or later:

```toml
name = "stash-consumer"
main = "src/index.ts"
compatibility_date = "2024-04-03"

[[services]]
binding = "STASH_RPC"
service = "zudo-history-stash"
entrypoint = "StashRpc"
```

Use the RPC transport with `createStashClient` for the usual client API. Type the binding as
`StashRpcEntrypoint`; the token is configured when the client is created and sent on every RPC
request, rather than stored on the binding.

```ts
import { createStashClient, type StashRpcEntrypoint } from "@takazudo/zudo-history-stash";

interface Env {
  STASH_RPC: StashRpcEntrypoint;
  STASH_TOKEN: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const client = createStashClient({
      transport: { kind: "rpc", binding: env.STASH_RPC, token: env.STASH_TOKEN },
    });
    const result = await client.files("demo").get("docs/guide.md");
    return Response.json(result);
  },
};
```

The binding also exposes direct typed methods when that shape is more convenient. The token is the
first argument to every method, and it still receives the normal authentication, scope, and
cross-stash `404` concealment checks:

```ts
const result = await env.STASH_RPC.getFile(env.STASH_TOKEN, "demo", "docs/guide.md");
```

After a typed method reaches `StashRpc`, business failures and internal exceptions become
serialisable `Result` unions (including an `internal` result). The outer service-binding invocation
can still reject before dispatch or during platform serialisation, including 32 MiB enforcement, so
callers should catch that boundary. The RPC client transport preserves `Content-Type`,
`Idempotency-Key`, and `If-None-Match`; its responses retain `ETag` and `Idempotent-Replayed`
behavior. A rejected binding call through the client instead throws `StashHttpError` with
`status === 0`.

The live events route is deliberately fetch-only and has no named `StashRpc` method. SSE is a
long-lived HTTP response rather than a structured-clone RPC result; consumers that need live
events use the fetch transport, including an HTTP service binding. The generic
`STASH_RPC.request()` bridge remains total for low-level HTTP-shaped dispatch, but it does not make
the route part of the typed named-method surface.

Cloudflare RPC serialisation is capped at 32 MiB. Independently, this API limits text bodies to
5,000,000 UTF-8 bytes and encoded HTTP requests to 32 MiB, so the API limits still apply before an
RPC method reaches storage. The existing `env.STASH.fetch()` service binding remains supported for
HTTP-compatible consumers.

## Routes

Binary metadata keeps representation (`text | binary`), content access (`inline | raw | deleted`),
transfer mode, and physical storage tier independent. Legacy rows default to text and resolve from
the legacy TEXT table; new versions carry an explicit storage discriminator so an identical SHA-256
may coexist in the legacy and byte tables without ambiguous reads. Binary bytes are never base64 in
JSON. Proposal candidates and history import remain JSON/text-only and reject raw/binary usage with
`422 unsupported-representation`.

Published defaults are 5,000,000 JSON-inline bytes, 524,288 D1-inline bytes, a 100,000,000-byte
operator-declared HTTP/file ceiling, 32 MiB single uploads, 524,288 diff bytes per side, 8 MiB
multipart parts, eight open sessions, 500,000,000 reserved bytes per stash, and a one-day session
TTL. Production parts are at least 5 MiB and total parts never exceed 10,000. `MAX_FILE_BYTES` may
be configured through 1 GiB only when reservation capacity is raised too; this is a correctness
boundary, not a performance/load-test claim. All thresholds count exact content bytes, excluding
JSON and protocol framing.

### `GET /v1/health`

- **Principal/capability:** `open`; no capability or token is required.
- **Request:** No body or query.
- **Response:** `200` with
  `{ "ok": true, "service": "zudo-history-stash", "marker": "ZHS_HEALTH_OK" }`.
- **Errors:** No route-level business errors. Infrastructure failures may still produce a network
  error or an internal response.

### `GET /v1/capabilities`

- **Principal/capability:** `open`; no capability or token is required.
- **Request:** No body or query.
- **Response:** `200` with representations, content-access modes, transfer modes, storage tiers,
  and the authoritative exact-content byte limits.
- **Errors:** `500 internal`.

### `GET /v1/me`

- **Principal/capability:** `any`; any valid credential.
- **Request:** No body or query.
- **Response:** `200 { "principal": "admin" }` for the administrator, or
  `200 { "principal": "stash", "stash": "demo", "tokenId": "tok_…", "scope": "read", "expiresAt": null }`.
- **Errors:** `401 unauthorized`, `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** Optional `limit` (default `50`, maximum `200`), `after=<stash-name>` keyset
  cursor, and `includeDeleted=true|false` (default `false`).
- **Response:** `200 { stashes, nextAfter }`. Each summary contains `name`, `description`, live
  `fileCount`, `deletedFileCount`, `lastChangeId`, `lastChangeAt`, `createdAt`, `deletedAt`,
  `restoreUntil`, and `restorable`. `nextAfter` is the last returned name when another page exists,
  otherwise `null`. Deleted rows are included only when `includeDeleted=true`; `restorable` is true
  only while the restoration window is open.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential.

### `POST /v1/stashes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** JSON `{ name, description?, meta? }`. Names match
  `^[a-z0-9][a-z0-9-]{0,62}$`.
- **Response:** `201` with the new stash record. Counts and last-change fields initially contain
  zeroes and `null` values; `deletedAt` and `restoreUntil` are `null`, and `restorable` is `false`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential,
  `409 exists`, `413 payload-too-large`.

### `GET /v1/stashes/:stash`

- **Principal/capability:** `admin-or-stash`; administrator or a token belonging to `:stash`.
- **Request:** No body or query.
- **Response:** `200` with `name`, `description`, `meta`, live `fileCount`, `deletedFileCount`,
  `lastChangeId`, `lastChangeAt`, `createdAt`, `deletedAt`, `restoreUntil`, and `restorable`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for an unknown or foreign
  stash, `429 rate-limited` with `Retry-After: 60`.

### `DELETE /v1/stashes/:stash`

- **Principal/capability:** `admin`; administrator only (lifecycle write class).
- **Request:** No body or query.
- **Response:** `200 { name, deletedAt, revokedTokens, restoreUntil }`. Deletion is soft: file,
  version, blob, and change rows remain untouched, active stash tokens are revoked, and the
  returned timestamps are captured from one operation. A stash name is never recycled, including
  after the restoration window expires.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `409 already-deleted`.

### `POST /v1/stashes/:stash/restore`

- **Principal/capability:** `admin`; administrator only (lifecycle write class).
- **Request:** No body or query.
- **Response:** `200` with the restored `StashRecord`. Restoring does not un-revoke tokens and
  leaves file, version, blob, and change rows unchanged.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for an unknown stash, a live
  stash, or a restoration window that has expired. These cases are intentionally indistinguishable.

### `POST /v1/stashes/:stash/tokens`

- **Principal/capability:** `admin`; administrator only.
- **Request:** JSON `{ label?, scope: "read" | "write", expiresAt? | ttlSeconds? }`.
  `expiresAt` is an ISO-8601 UTC timestamp and `ttlSeconds` is a positive integer up to
  `315360000`; the fields are mutually exclusive. The server requires the resolved expiry to be
  in the future and no more than ten years away.
- **Response:** `201 { id, token, label, scope, createdAt, expiresAt, rotatedFrom }`. The `zhs_…`
  token is returned only by this creation call; storage retains its hash, not the secret. A token
  created directly has `rotatedFrom: null`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `413 payload-too-large`.

### `GET /v1/stashes/:stash/tokens`

- **Principal/capability:** `admin`; administrator only.
- **Request:** No body or query.
- **Response:** `200 { tokens }`, newest first. Records contain `id`, `label`, `scope`,
  `createdAt`, `expiresAt`, `rotatedFrom`, `rotatedTo`, `revokedAt`, and `lastUsedAt`, but never
  the token secret.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`.

### `POST /v1/stashes/:stash/tokens/:id/rotate`

- **Principal/capability:** `admin`; administrator only.
- **Request:** JSON `{ graceSeconds?, expiresAt? | ttlSeconds? }`. `graceSeconds` defaults to
  `300` and accepts integers from `0` through `86400`. The optional successor expiry fields use
  the same mutually exclusive rules as token creation.
- **Response:** `201` with a one-time successor containing `id`, `token`, `label`, `scope`,
  `createdAt`, `expiresAt`, `rotatedFrom`, and `predecessor: { id, expiresAt }`. Without an expiry
  override, the successor keeps the predecessor's original expiry; `null` remains `null`. The
  predecessor's expiry is shortened to the earlier of its existing expiry and the grace
  deadline.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for an unknown or revoked
  predecessor, `409 already-rotated`, `409 token-expired`, `413 payload-too-large`.

Rotation is one-shot: one predecessor can name only one successor, and concurrent attempts yield
one winner. A later attempt returns `already-rotated` with the winner's ID in
`error.successorId`. If the successful response is lost, the one-time secret cannot be recovered;
use the predecessor's `rotatedTo` value to identify and revoke the successor, then create a new
token.

### `DELETE /v1/stashes/:stash/tokens/:id`

- **Principal/capability:** `admin`; administrator only.
- **Request:** No body.
- **Response:** `204` with no body. Revocation sets `revokedAt`; the token can no longer
  authenticate.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for an unknown stash/token.

### `POST /v1/stashes/:stash/import`

- **Principal/capability:** `admin`; administrator only.
- **Request:** JSON `{ path, expectedVersion, versions }`. `expectedVersion` is `null` for a new
  path or the current positive version when continuing an import. One call accepts 1–20 entries.
  A `put` entry has a string `body`; a `delete` entry has `body: null`; a `rollback` entry has
  `body: null` and `rollbackOf` naming an earlier live version. Each entry carries non-decreasing
  epoch-ms `createdAt`, with optional `author`, `message`, and `meta`.
- **Response:** `201 { path, headVersion, firstChangeId }`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `409 stale`, `409 exists`,
  `413 payload-too-large`, `422 unsupported-representation`, `500 internal`.

See [Importing an existing corpus](#importing-an-existing-corpus) for chaining.

### `GET /v1/changes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** Optional `limit` plus either `since=<change-id>` or `before=<change-id>`, never
  both. With neither cursor, results are newest first.
- **Response:** `200 { changes, nextSince | nextBefore, hasMore }`. Each item contains
  `changeId`, `stash`, `path`, `version`, `kind`, `author`, `message`, `size`, and `createdAt`.
  `since` pages are ascending for polling; `before` and initial pages are descending for UIs.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential.

### `POST /v1/admin/gc`

- **Principal/capability:** `admin`; administrator only (lifecycle/write class).
- **Request:** Strict JSON `{ kind, dryRun?, maxObjects?, cursor? }`. `kind` is `r2-orphans` or
  `ledger`; `dryRun` defaults to `false`; `maxObjects` defaults to `100` and accepts integers from
  `1` through `500`; `cursor` is an opaque, kind-bound v1 base64url cursor envelope. An explicit
  cursor overrides the stored job cursor for this page.
- **Response:** `200` with one synchronously completed `GcRunResult` page. `jobId` is the stable
  logical job ID and always equals `kind`; `runId` is a per-page UUID. `scanned`, `eligible`, and
  `deleted` are bounded by the requested page, although an invocation safety budget may stop a
  page below the requested `maxObjects`. `cursor: null` means this pass is complete; a later
  invocation starts a fresh pass.
- **Errors:** `400 validation`, `401 unauthorized`, `409 gc-busy` when the same kind has a live
  fenced lease.

Dry runs acquire the same five-minute fenced lease and record a run, but never delete objects or
persist a job cursor. A non-dry page persists only after its lease owner/generation is verified;
stale runners cannot heartbeat, finalize, or release a successor lease. R2 orphan scans treat
private R2 keys as opaque implementation details: keys never appear in responses or logs. Run
history retains the newest five hundred records per kind.

### `GET /v1/admin/gc/runs`

- **Principal/capability:** `admin`; administrator only (read class).
- **Request:** Optional `kind=r2-orphans|ledger` and `limit` (default `50`, maximum `200`). Results
  are newest-first and deterministic.
- **Response:** `200 { runs: GcRunResult[] }`. Each run has its UUID `runId`, stable `jobId` equal to
  its `kind`, dry-run flag, counters, opaque cursor or `null`, timestamps, and nullable error.
  The engine's invocation safety budget may stop a page below the requested `maxObjects`.
- **Errors:** `400 validation`, `401 unauthorized`.

#### Operating garbage collection

Start a manual operation with a dry run, then repeat the same `kind` without `dryRun` after
reviewing the counters:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $STASH_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"kind":"r2-orphans","dryRun":true,"maxObjects":80}' \
  https://stash.example.com/v1/admin/gc
```

The R2 engine caps every page at 24 objects; the ledger accepts up to 500 rows per request. The
scheduled handler requests 80 objects, alternates R2 and ledger pages, shares one 45-operation
budget across the whole invocation, and stops after ten pages per kind or before the next page
would exceed that budget. Pass returned cursors unchanged when continuing an explicit page;
omitting `cursor` uses the stored progress. `cursor: null` restarts a later pass from the beginning.
If a lease expires or a worker is interrupted, retry the same kind after the five-minute lease
window; a `409 gc-busy` response means another page currently owns the fenced lease. Dry runs
never delete data or persist progress, and no response, run record, or log exposes an R2 key or
generation.

The production cron invokes this bounded round-robin at `17 3 * * *` UTC. Preview has no cron and
must be run manually. Deploy generation-aware v2 writers and the migration before the API, verify
the API's dry-run and recovery behavior, and deploy/enable the production schedule last.

### `POST /v1/stashes/:stash/proposals`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** Strict JSON `{ path, body, baseVersion, author?, message?, meta?, expiresAt? }`,
  optionally with `Idempotency-Key`. `baseVersion` is a positive version or `null` when the path
  must not exist. `path` and `body` use the normal file-path and 5 MB well-formed-text rules.
  `expiresAt`, when supplied, is a future ISO timestamp; otherwise the server uses
  `PROPOSAL_TTL_DAYS` (default 14). `meta.proposalId` is platform-owned and therefore rejected;
  the server stamps the generated proposal ID and validates the final metadata size.
- **Response:** `201 ProposalRecord`. Replaying the same key and canonical body returns the same
  record with the same `201` status and `Idempotent-Replayed: true`.
- **Errors:** `400 validation`, `400 body-not-well-formed`, `401 unauthorized`, `403 scope`,
  `404 not-found`, `413 payload-too-large`, `422 idempotency-key-reused`,
  `422 unsupported-representation`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/proposals`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `status=open|applied|rejected|expired|all` (default `open`), exact `path`,
  `limit` (default `50`, maximum `200`), and opaque `after` cursor.
- **Response:** `200 { proposals, nextAfter, total }`. Results are ordered newest first by
  `createdAt`, then `id`; `total` counts all rows matching the selected status and path filters,
  not only the returned page. `nextAfter` is `null` when the filtered result is exhausted.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `429 rate-limited` with
  `Retry-After: 60`.

### `GET /v1/stashes/:stash/proposals/:id`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** No body or query.
- **Response:** `200 ProposalWithBody`, containing the proposal record plus its immutable
  candidate `body`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/proposals/:id/diff`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional non-negative `context` query value.
- **Response:** `200 ProposalDiffResult`: the normal three-state `DiffResult` plus immutable
  `base`, `candidate`, and separately moving `current` and `stale` fields.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/proposals/:id/approve`

- **Principal/capability:** `write`; administrator or a matching `write` token. There is no
  built-in approval policy or caller-supplied approver identity.
- **Request:** Strict JSON `{ author?, message? }`. These optional values override the proposal's
  stored author/message on the applied version; they do not control `decidedBy`.
- **Response:** `200 { status: "applied", appliedVersion, appliedChangeId, hash, createdAt }`.
  Re-approval of an already-applied proposal reconstructs and returns the same stored result,
  including after the proposal's expiry time.
- **Errors:** `400 validation`, `401 unauthorized`, `403 scope`, `404 not-found`, `409 stale`
  with root-level `current`, `409 proposal-expired`, `409 proposal-closed`,
  `413 payload-too-large`, `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/proposals/:id/reject`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** Strict JSON `{ reason? }`; the optional well-formed reason is bounded to 2,000
  UTF-8 bytes.
- **Response:** `200 ProposalRecord`. Re-rejecting an already-rejected proposal is idempotent.
  An open proposal may be rejected even when its expiry time has passed.
- **Errors:** `400 validation`, `401 unauthorized`, `403 scope`, `404 not-found`,
  `409 proposal-closed` for an applied proposal, `413 payload-too-large`, `429 rate-limited` with
  `Retry-After: 60`.

### `GET /v1/stashes/:stash/events`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token. This route is
  fetch-only and one `RL_READ` charge is applied when the connection opens.
- **Request:** Optional `since=<change-id>`, a non-negative integer replay checkpoint. No body.
- **Response:** `200 text/event-stream` with `Cache-Control: no-store` and
  `X-Accel-Buffering: no`. The stream uses `event:`, `id:`, and `data:` fields for `ready`,
  `change`, `proposal`, and `reconnect` events; heartbeat comments are not events. See
  [Live change events](#live-change-events).
- **Errors:** Before any stream bytes: `401 unauthorized`, `403 scope`, `404 not-found` for an
  unknown, deleted, or foreign stash, and `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes/:stash/files`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `includeDeleted=true|false`, `limit`, and `after=<path>` keyset cursor.
- **Response:** `200 { files, nextAfter }`. File summaries contain `path`, `headVersion`, `hash`,
  `size`, `deleted`, and `updatedAt`; paths are ascending.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a foreign stash,
  `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes/:stash/files/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `version=<positive integer>` and optional `If-None-Match` header.
- **Response:** `200` with the fields `path`, `version`, `hash`, `size`, `kind`, `author`,
  `message`, `meta`, `createdAt`, `deleted`, and `body`, plus `ETag` and `X-Stash-Version`. A
  requested tombstone version is `200` with `deleted: true`, `hash: null`, and `body: null`. A
  matching conditional request is `304` with no body and includes `ETag` and `X-Stash-Version`.
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `404 not-found`,
  `404 file-deleted` for a tombstoned head, `404 version-not-found`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `PUT /v1/stashes/:stash/files/*path`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** JSON with `body`, `expectedVersion`, and optional `author`, `message`, `meta`,
  `contentType`, and `skipIfUnchanged`, optionally with `Idempotency-Key`. `expectedVersion: null`
  is create-only; otherwise it must equal the current head.
- **Response:** `201 { version, hash, size, changeId, createdAt }`. With
  `skipIfUnchanged: true`, byte-identical live content returns
  `200 { unchanged: true, version }` without appending history. A replay preserves the original
  status and adds `Idempotent-Replayed: true`.
- **Errors:** `400 validation`, `400 invalid-path`, `400 body-not-well-formed`,
  `401 unauthorized`, `403 scope`, `404 not-found`, `409 stale`, `409 exists`,
  `413 payload-too-large`, `422 idempotency-key-reused`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/delete/*path`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** JSON `{ expectedVersion, author?, message? }`, optionally with
  `Idempotency-Key`. This is `POST`, not `DELETE`, because intermediaries can discard DELETE
  bodies.
- **Response:** `200 { version, changeId, createdAt }`; the new version is a tombstone. A replay
  adds `Idempotent-Replayed: true`.
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `403 scope`,
  `404 not-found`, `409 stale`, `409 already-deleted`, `413 payload-too-large`,
  `422 idempotency-key-reused`, `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/rollback/*path`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** JSON `{ toVersion, expectedVersion, author?, message?, meta? }`, optionally with
  `Idempotency-Key`.
- **Response:** `201 { version, hash, rollbackOf, identicalToHead, changeId, createdAt }`.
  Rollback always appends a version, even when the target bytes equal the head. A replay adds
  `Idempotent-Replayed: true`.
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `403 scope`,
  `404 not-found`, `404 version-not-found`, `409 stale`, `413 payload-too-large`,
  `422 idempotency-key-reused`, `422 rollback-target-tombstone`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/history/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `limit` and `before=<version>` keyset cursor.
- **Response:** `200 { path, headVersion, deleted, total, versions, nextBefore }`. Versions are
  newest first and contain metadata but no bodies: `version`, `kind`, `hash`, `size`,
  `rollbackOf`, `author`, `message`, `meta`, and `createdAt`.
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `404 not-found`,
  `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes/:stash/diff/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Required `from=<version>` and `to=<version|head>`. Optional `context` is 0–10;
  optional `maxUnifiedBytes` truncates only the unified text at a line boundary.
- **Response:** `200` with a `DiffResult` plus `{ from, to }` side metadata. See
  [Diff results](#diff-results).
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `404 not-found`,
  `404 version-not-found`, `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/diff/*path`

- **Principal/capability:** `read`; this POST computes a candidate preview in memory and does not
  write. A matching `read` token is sufficient.
- **Request:** JSON `{ from: <version> | "head", body, context? }`.
- **Response:** `200` with a `DiffResult`. Labels identify the right side as `b/<path>@candidate`; no body,
  blob, or version is persisted.
- **Errors:** `400 validation`, `400 invalid-path`, `400 body-not-well-formed`,
  `401 unauthorized`, `404 not-found`, `404 version-not-found`, `413 payload-too-large`,
  `422 unsupported-representation`,
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/changes`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `limit` plus either `since=<change-id>` or `before=<change-id>`, never
  both.
- **Response:** `200` with the same `{ changes, nextSince | nextBefore, hasMore }` shape as the admin feed,
  restricted to `:stash`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a foreign stash,
  `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes/:stash/raw/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `If-None-Match`, `Range`, and application-ETag `If-Range` headers.
- **Response:** `200` exact bytes or `206` one range with `ETag`, `X-Stash-Version`,
  `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, `Content-Disposition`, and
  `X-Content-Type-Options`; `304` has `ETag` and no body.
- **Errors:** `400 invalid-path`, `401 unauthorized`, `404 not-found`, `404 file-deleted`,
  `416 range-not-satisfiable` with `Content-Range`, `429 rate-limited` with `Retry-After: 60`,
  `500 internal`.

### `HEAD /v1/stashes/:stash/raw/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `If-None-Match`, `Range`, and application-ETag `If-Range` headers.
- **Response:** `200` or `206` with `ETag`, `X-Stash-Version`, `Accept-Ranges`, `Content-Length`,
  `Content-Range`, `Content-Type`, `Content-Disposition`, and `X-Content-Type-Options`; `304` has
  `ETag`. HEAD never emits content bytes.
- **Errors:** `400 invalid-path`, `401 unauthorized`, `404 not-found`, `404 file-deleted`,
  `416 range-not-satisfiable` with `Content-Range`, `429 rate-limited` with `Retry-After: 60`,
  `500 internal`.

### `GET /v1/stashes/:stash/versions/:version/raw/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Historical version in the path plus optional conditional/range headers.
- **Response:** `200` exact bytes or `206` one range with `ETag`, `X-Stash-Version`,
  `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, `Content-Disposition`, and
  `X-Content-Type-Options`; `304` has `ETag` and no body.
- **Errors:** `400 invalid-path`, `401 unauthorized`, `404 not-found`, `404 version-not-found`,
  `404 file-deleted`, `416 range-not-satisfiable` with `Content-Range`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `HEAD /v1/stashes/:stash/versions/:version/raw/*path`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Historical version in the path plus optional conditional/range headers.
- **Response:** `200` or `206` with `ETag`, `X-Stash-Version`, `Accept-Ranges`, `Content-Length`,
  `Content-Range`, `Content-Type`, `Content-Disposition`, and `X-Content-Type-Options`; `304` has
  `ETag`. HEAD never emits content bytes.
- **Errors:** `400 invalid-path`, `401 unauthorized`, `404 not-found`, `404 version-not-found`,
  `404 file-deleted`, `416 range-not-satisfiable` with `Content-Range`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/uploads/*path`

- **Principal/capability:** `write`; administrator or a matching `write` token.
- **Request:** JSON metadata with exact `size`, optional SHA-256 `hash`, `representation`,
  `contentType`, expected-version CAS, and transfer preference; creation has its own
  `Idempotency-Key` fingerprint.
- **Response:** `201` session with `Idempotent-Replayed`, chosen mode/tier, expiry, and generation.
- **Errors:** `400 validation`, `400 invalid-path`, `401 unauthorized`, `403 scope`,
  `404 not-found`, `409 stale`, `413 payload-too-large`, `422 idempotency-key-reused`,
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/uploads/:sessionId`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** No body.
- **Response:** `200` durable session state and server-recorded current-generation parts.
- **Errors:** `401 unauthorized`, `403 scope`, `404 not-found`, `429 rate-limited` with
  `Retry-After: 60`.

### `DELETE /v1/stashes/:stash/uploads/:sessionId`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** JSON generation plus an abort-specific `Idempotency-Key`.
- **Response:** `200 { id, state: "aborted" }` with `Idempotent-Replayed`.
- **Errors:** `400 validation`, `401 unauthorized`, `403 scope`, `404 not-found`,
  `409 upload-session-not-open`, `410 upload-session-expired`, `422 idempotency-key-reused`,
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `PUT /v1/stashes/:stash/uploads/:sessionId/content`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** One raw byte stream with optional `Content-Length` and a distinct upload
  `Idempotency-Key` fingerprint.
- **Response:** `202` durable uploaded session with `Idempotent-Replayed`.
- **Errors:** `400 body-not-well-formed`, `401 unauthorized`, `403 scope`, `404 not-found`,
  `409 upload-session-not-open`, `410 upload-session-expired`, `413 payload-too-large`,
  `422 upload-size-mismatch`, `422 upload-hash-mismatch`, `422 idempotency-key-reused`,
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `PUT /v1/stashes/:stash/uploads/:sessionId/parts/:partNumber`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** One raw part, current generation query, and part-specific idempotency fingerprint.
- **Response:** `202` updated status with `Idempotent-Replayed`.
- **Errors:** `400 validation`, `401 unauthorized`, `403 scope`, `404 not-found`,
  `409 upload-session-not-open`, `410 upload-session-expired`, `413 payload-too-large`,
  `422 upload-size-mismatch`, `422 idempotency-key-reused`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/uploads/:sessionId/complete`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** JSON generation and a completion-specific `Idempotency-Key` fingerprint.
- **Response:** `201` committed version with `Idempotent-Replayed`.
- **Errors:** `400 validation`, `400 body-not-well-formed`, `401 unauthorized`, `403 scope`,
  `404 not-found`, `409 stale`, `409 upload-session-not-open`, `410 upload-session-expired`,
  `422 upload-size-mismatch`, `422 upload-hash-mismatch`, `422 idempotency-key-reused`,
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `POST /v1/stashes/:stash/uploads/:sessionId/resume`

- **Principal/capability:** `write`; the session-bound administrator or matching stash principal.
- **Request:** JSON generation and completion fingerprint for recovery/takeover.
- **Response:** `200` durable session or replayed result with `Idempotent-Replayed`.
- **Errors:** `400 validation`, `401 unauthorized`, `403 scope`, `404 not-found`,
  `410 upload-session-expired`, `422 idempotency-key-reused`, `429 rate-limited` with
  `Retry-After: 60`, `500 internal`.

## Proposals

A proposal is a stored candidate write: its path, candidate body, exact `baseVersion`, author,
message, metadata, expiry, and optional creation idempotency key. Its ID is time-sortable
(`prp_` plus a zero-padded 13-digit epoch-millisecond value and eight lowercase hex digits).
`ProposalRecord` always includes `expiresAt` and has these lifecycle fields:

- `status`: `open`, `applied`, `rejected`, or computed `expired`;
- `decidedAt`, `decidedBy`, and `decisionReason` (nullable until a decision);
- `appliedVersion` and `appliedChangeId` (nullable unless applied).

Expiry is computed when an open proposal has `expiresAt <= now`; equality is expired. Expiry does
not erase the proposal or its candidate. Approval of an expired open proposal returns
`proposal-expired`, while rejection is still allowed and an already-applied proposal remains
idempotently readable/approvable. `decidedBy` is always the authenticated identity (`admin` or the
stash token ID), never a caller-supplied string.

Approval is an exact-head fenced operation, not a rebase. One attempt first claims a live, open,
unexpired proposal only when the path head still equals `baseVersion`; it then inserts an ordinary
`put` version and writes the file head last in the same fenced batch. Exactly one changed head row
is the verdict. A losing attempt writes no partial proposal, version, or head state. If the head
moved, the API returns `409 stale` with `current` and leaves the proposal open. A successful
version gets platform-stamped `meta.proposalId`, so the normal history, change feed, rollback, and
diff surfaces retain the audit link. Approval appends one normal version even when the candidate
body matches the base body. Repeating approval after a winner returns that winner's stored version
result; rejecting an applied proposal returns `proposal-closed`.

Any administrator or matching `write` credential may approve. Required approvers, roles, review
comments, and other policy belong to consumers rather than this minimal platform flow.

The review diff is permanently `base -> candidate`: a missing base or base tombstone is empty
text, and the candidate comes from the proposal's referenced blob. `current` reports the live path
head (or `null` when absent), while `stale` compares that moving head version with `baseVersion`.
Moving the head never changes the displayed diff. An applied proposal normally reports
`stale: true` afterward because approval advanced the head; consumers should read `status` before
interpreting that flag.

## Live change events

`GET /v1/stashes/:stash/events?since=<changeId>` is an advisory Server-Sent Events (SSE) channel.
Callers still refetch the existing file list, history, change-feed, and proposal surfaces; the live
channel is never the source of truth. It is intentionally fetch-only. Browser `EventSource`
cannot attach the required bearer `Authorization` header, so clients use `fetch` and read the
response stream. The named RPC table mechanically excludes this route.

Each SSE frame uses an `event:` name, optional `id:`, and one JSON `data:` object. Change frame IDs
equal their exact `changeId`; heartbeats are the comment `: ping` every 25 seconds and do not
produce `StashEvent` values.

```text
event: change
id: 42
data: {"type":"change","changeId":42,"stash":"demo","path":"docs/guide.md","version":7,"kind":"put","origin":"viewer-1","createdAt":"2026-08-28T00:00:00.000Z"}
```

The validated event union is:

- `ready { type, head: number | null, checkpoint: number | null }`, emitted after replay;
- `change { type, changeId, stash, path, version, kind, origin: string | null, createdAt }`;
- `proposal { type, proposalId, stash, path, status, origin: string | null }`;
- `reconnect { type, reason: "lifetime" | "replay-limit" | "shutdown" }`.

The server authorizes the credential, resolves a live stash, and charges `RL_READ` before sending
bytes. It then subscribes to the stash Durable Object first and buffers live frames while replaying
`listChanges(stash, { since, limit: 200 })`, for at most five pages. After replay it emits `ready`,
drains the buffered live frames, and passes new live frames through. Subscribing before replay
closes the commit-between-read-and-subscribe gap. When more than five replay pages remain, the
server emits `reconnect { reason: "replay-limit" }` after those pages and closes so the client can
continue from the returned checkpoint.

`ready.checkpoint` is the last change ID replayed, or the current `head` on a fresh connection.
The client reconnects with that replay checkpoint (or the last replayed change ID), not merely the
latest live ID: Durable Object delivery can arrive out of order, so advancing the checkpoint from
a live frame could skip a D1 change. Duplicates across the replay/live boundary are valid and the
client removes them by exact ID over a bounded recent-ID set. Proposal events are live-only and do
not advance the replay cursor; focus/visibility refresh and polling recover any missed proposal
state.

Healthy streams rotate after a bounded lifetime (300 seconds by default). A clean close or
`reconnect` reason is normal rotation, not a failure; clients reconnect immediately with at most
250 ms jitter. Network failures use bounded exponential backoff separately. Revoking or expiring a
token, or soft-deleting a stash, stops delivery no later than the next forced reconnect; the bound
is the lesser of the configured maximum stream lifetime and any earlier token-expiry boundary.
Reauthorization then returns `401` or `404` before a new stream opens.

Mutations may send `X-Stash-Client-Id` with a stable client identifier matching
`^[!-~](?:[ -~]{0,62}[!-~])?$`: 1–64 printable ASCII characters with no leading or trailing
whitespace. The client sends it on mutation operations, and live events echo it as `origin`;
absent identifiers produce `null` and the value is advisory, never authorization. Replayed changes
always have `origin: null`.

The fan-out Durable Object uses SQLite-backed Durable Objects, which are available on Cloudflare's
free plan. An open SSE response keeps the object active and non-hibernating, so an always-open
viewer accrues Durable Object duration continuously even though each connection rotates every five
minutes.

## Diff results

Stored and candidate diffs return one of three states:

```ts
type DiffResult =
  | { state: "same" }
  | { state: "oversized"; reason: "bytes" | "complexity" }
  | {
      state: "ready";
      unified: string;
      truncated: boolean;
      hunks: Array<{
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        lines: string[];
      }>;
      stats: { added: number; removed: number };
    };
```

Each side above 524,288 UTF-8 bytes returns `oversized/bytes`; a diff that exceeds the bounded
compute budget returns `oversized/complexity`. Tombstone sides are treated as empty text. Diff
results are computed on demand and never stored.

## Representation tags and conditional reads

`GET …/files/*path` returns a strong representation tag:

```text
"v<N>-<hash>"
"v<N>-deleted"
```

For live content, `<hash>` is `sha256-` plus 64 lowercase hex characters. The version is part of
the tag, so a rollback that reuses an old blob still has a new ETag. Send it in `If-None-Match` to
receive `304` with no body. Comma-separated tags, `*`, and weak `W/` prefixes are accepted for
comparison. The client exposes the response tag as `value.etag` and represents `304` as
`{ ok: true, notModified: true }`.

## Idempotent writes

`PUT`, delete, and rollback accept `Idempotency-Key` values from 1 to 200 characters. Their
seven-day ledger binds a key to the canonical operation, path, expected version, body hash, target
version, metadata, and normalized defaults.

- Repeating the same request within the seven-day ledger window rebuilds the original response,
  preserves its original HTTP status, and sets `Idempotent-Replayed: true`.
- Reusing the key for a different canonical request returns `422 idempotency-key-reused`.
- A stale or otherwise refused write records nothing.
- `skipIfUnchanged` results run no batch and are not ledgered.

The client mints a key for each mutation. Pass `{ idempotencyKey: "stable-job-key" }` when a retry
must replay the same operation across process restarts.

Proposal creation accepts the same header but stores the key and canonical request hash on the
proposal row rather than in the version ledger. Repeating the same stash/key/body returns the
existing proposal with `201` and `Idempotent-Replayed: true`; reusing the key with any different
canonical body returns `422 idempotency-key-reused`. Proposal approval is idempotent by stored
state instead: repeated approval returns the applied version result and does not append again.

## Pagination and change polling

Every `limit` defaults to 50 and has a maximum of 200. Values above 200 return `400 validation`;
they are never silently clamped.

- Stash and file lists use `after` and return `nextAfter`.
- Proposal lists use an opaque `after` cursor over `createdAt DESC, id DESC` and return
  `nextAfter`; `total` is the count for the full applied filter.
- History uses `before=<version>` and returns `nextBefore`.
- Change feeds use `since=<changeId>` for ascending polling or `before=<changeId>` for descending
  UI pagination. They are mutually exclusive.
- With neither change cursor, the newest changes are returned first.

Pass the returned cursor unchanged into the next request. A `null` next cursor means the current
page exhausted the result set.

## Consumer write protocol

Every file mutation is compare-and-set (CAS):

1. Read the file head and retain its `version`.
2. Send that value as `expectedVersion`. Use `null` only when the path must not exist.
3. On `409 stale`, inspect the root-level `current`, decide whether to recompute, and retry with a
   new operation. Do not blindly overwrite the winner.

`putLatest(stash, path, body)` performs the read and up to three bounded stale retries for simple
last-head updates. Use explicit `files.put` when the consumer needs its own conflict policy.

A put with the current expected version may resurrect a tombstoned path. Create-only
`expectedVersion: null` does not resurrect: a tombstoned row already exists and returns
`409 exists` with `current.deleted: true`.

## Rollback semantics

Rollback restores a target version's blob by appending a new `rollback` version. It never deletes
or rewrites history, and it still appends when the target bytes are identical to the current head.
`identicalToHead` tells the consumer about that case. A rollback may resurrect a tombstoned head,
but a tombstone cannot be the target; that returns `422 rollback-target-tombstone` and the caller
should use delete when a tombstone is intended.

## Importing an existing corpus

The administrator-only import endpoint preserves existing authors, messages, metadata, and
timestamps instead of flattening a corpus into a PUT loop. A call appends at most 20 entries in
one fenced batch. Chain a longer history by sending the first result's `headVersion` as the next
call's `expectedVersion`:

```ts
const first = await client.stashes.import("demo", {
  path: "docs/legacy.md",
  expectedVersion: null,
  versions: firstTwenty,
});
if (!first.ok) throw new Error(first.error.message);

const next = await client.stashes.import("demo", {
  path: "docs/legacy.md",
  expectedVersion: first.value.headVersion,
  versions: remaining,
});
```

`createdAt` must be non-decreasing and cannot be in the future. A rollback entry can target an
earlier live version from the same call or a prior chained call. The 20-version count is not a
promise that 20 large versions fit in one request: chunk imports so each encoded JSON request,
including escaping, stays at or below 32 MiB.

## CORS and browser tokens

Browser origins must appear in the Worker's `ALLOWED_ORIGINS` allow-list. Preflight is open. The
API accepts `Authorization`, `Content-Type`, `If-None-Match`, `Idempotency-Key`, and
`X-Stash-Client-Id`, and exposes `ETag`, `X-Stash-Version`, `Idempotent-Replayed`, and
`Retry-After`. `X-Stash-Client-Id` is a request header only and is not exposed in responses.

> **Browser-token warning:** only put `read` tokens in client-side code. A `write` token is a
> full-stash credential: anyone who extracts it can replace, delete, or roll back every path in
> that stash. Keep write and administrator tokens in a trusted server or Worker secret.

## Deferred

The v1 HTTP contract intentionally defers:

- multi-file atomic commits; v1 history and CAS are per path.
- proposal approval policy (required approvers, roles, and review comments); any matching `write`
  credential can approve.
