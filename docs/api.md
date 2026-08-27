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

| HTTP  | Codes                                                                    |
| ----- | ------------------------------------------------------------------------ |
| `400` | `validation`, `invalid-path`, `body-not-well-formed`                     |
| `401` | `unauthorized`                                                           |
| `403` | `scope`                                                                  |
| `404` | `not-found`, `file-deleted`, `version-not-found`                         |
| `409` | `stale`, `exists`, `already-deleted`, `already-rotated`, `token-expired` |
| `413` | `payload-too-large`                                                      |
| `422` | `idempotency-key-reused`, `rollback-target-tombstone`                    |
| `429` | `rate-limited`                                                           |
| `500` | `internal`                                                               |

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

Text bodies of at most **524,288 bytes** are stored inline in D1. Larger bodies are stored in
private R2 under content-addressed keys; D1 retains the authoritative metadata, hash, size, file
head, history, and pointer. Reads verify the R2 object's raw byte size and SHA-256 hash before a
fatal, BOM-preserving UTF-8 decode. Responses never expose the private object key. Diffing remains
limited to 524,288 bytes per side, so equal-hash and oversized results use metadata without
loading R2 bodies.

Compare-and-set eligibility is checked before upload. An eligible large write uploads to R2 before
the fenced D1 commit; a race or other refusal after upload can therefore leave an unreferenced
private content-addressed orphan for future garbage collection (future GC). The orphan is not
reachable through the API.

## Rate limits

Routes reachable by stash principals use three Cloudflare rate-limit buckets. `RL_READ` permits
600 operations per 60 seconds, `RL_WRITE` permits 60 per 60 seconds, and `RL_DIFF` permits 120 per
60 seconds. Stored and candidate diff routes use `RL_DIFF`; write-capability file routes use
`RL_WRITE`; `/v1/me`, stash metadata, file reads/lists/history, and the per-stash change feed use
`RL_READ`.

Each request checks `p:<tokenId>` first and then `s:<principal-stash>`. A failed principal check
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

Cloudflare RPC serialisation is capped at 32 MiB. Independently, this API limits text bodies to
5,000,000 UTF-8 bytes and encoded HTTP requests to 32 MiB, so the API limits still apply before an
RPC method reaches storage. The existing `env.STASH.fetch()` service binding remains supported for
HTTP-compatible consumers.

## Routes

### `GET /v1/health`

- **Principal/capability:** `open`; no capability or token is required.
- **Request:** No body or query.
- **Response:** `200` with
  `{ "ok": true, "service": "zudo-history-stash", "marker": "ZHS_HEALTH_OK" }`.
- **Errors:** No route-level business errors. Infrastructure failures may still produce a network
  error or an internal response.

### `GET /v1/me`

- **Principal/capability:** `any`; any valid credential.
- **Request:** No body or query.
- **Response:** `200 { "principal": "admin" }` for the administrator, or
  `200 { "principal": "stash", "stash": "demo", "tokenId": "tok_…", "scope": "read", "expiresAt": null }`.
- **Errors:** `401 unauthorized`, `429 rate-limited` with `Retry-After: 60`.

### `GET /v1/stashes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** Optional `limit` (default `50`, maximum `200`) and `after=<stash-name>` keyset
  cursor.
- **Response:** `200 { stashes, nextAfter }`. Each summary contains `name`, `description`, live
  `fileCount`, `deletedFileCount`, `lastChangeId`, `lastChangeAt`, and `createdAt`. `nextAfter` is
  the last returned name when another page exists, otherwise `null`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential.

### `POST /v1/stashes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** JSON `{ name, description?, meta? }`. Names match
  `^[a-z0-9][a-z0-9-]{0,62}$`.
- **Response:** `201` with the new stash record. Counts and last-change fields initially contain
  zeroes and `null` values.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential,
  `409 exists`, `413 payload-too-large`.

### `GET /v1/stashes/:stash`

- **Principal/capability:** `admin-or-stash`; administrator or a token belonging to `:stash`.
- **Request:** No body or query.
- **Response:** `200` with `name`, `description`, `meta`, live `fileCount`, `deletedFileCount`,
  `lastChangeId`, `lastChangeAt`, and `createdAt`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for an unknown or foreign
  stash, `429 rate-limited` with `Retry-After: 60`.

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
  `413 payload-too-large`, `500 internal`.

See [Importing an existing corpus](#importing-an-existing-corpus) for chaining.

### `GET /v1/changes`

- **Principal/capability:** `admin`; administrator only.
- **Request:** Optional `limit` plus either `since=<change-id>` or `before=<change-id>`, never
  both. With neither cursor, results are newest first.
- **Response:** `200 { changes, nextSince | nextBefore, hasMore }`. Each item contains
  `changeId`, `stash`, `path`, `version`, `kind`, `author`, `message`, `size`, and `createdAt`.
  `since` pages are ascending for polling; `before` and initial pages are descending for UIs.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a stash credential.

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
  `429 rate-limited` with `Retry-After: 60`, `500 internal`.

### `GET /v1/stashes/:stash/changes`

- **Principal/capability:** `read`; administrator or a matching `read`/`write` token.
- **Request:** Optional `limit` plus either `since=<change-id>` or `before=<change-id>`, never
  both.
- **Response:** `200` with the same `{ changes, nextSince | nextBefore, hasMore }` shape as the admin feed,
  restricted to `:stash`.
- **Errors:** `400 validation`, `401 unauthorized`, `404 not-found` for a foreign stash,
  `429 rate-limited` with `Retry-After: 60`.

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

`PUT`, delete, and rollback accept `Idempotency-Key` values from 1 to 200 characters. The ledger
binds a key to the canonical operation, path, expected version, body hash, target version,
metadata, and normalized defaults.

- Repeating the same request within the seven-day ledger window rebuilds the original response,
  preserves its original HTTP status, and sets `Idempotent-Replayed: true`.
- Reusing the key for a different canonical request returns `422 idempotency-key-reused`.
- A stale or otherwise refused write records nothing.
- `skipIfUnchanged` results run no batch and are not ledgered.

The client mints a key for each mutation. Pass `{ idempotencyKey: "stable-job-key" }` when a retry
must replay the same operation across process restarts.

## Pagination and change polling

Every `limit` defaults to 50 and has a maximum of 200. Values above 200 return `400 validation`;
they are never silently clamped.

- Stash and file lists use `after` and return `nextAfter`.
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
API accepts `Authorization`, `Content-Type`, `If-None-Match`, and `Idempotency-Key`, and exposes
`ETag`, `X-Stash-Version`, `Idempotent-Replayed`, and `Retry-After`.

> **Browser-token warning:** only put `read` tokens in client-side code. A `write` token is a
> full-stash credential: anyone who extracts it can replace, delete, or roll back every path in
> that stash. Keep write and administrator tokens in a trusted server or Worker secret.

## Deferred

The v1 HTTP contract intentionally defers:

- binary request bodies and additional content types beyond UTF-8 text;
- byte-range reads and dedicated download endpoints;
- multi-file atomic commits; v1 history and CAS are per path.
