# zudo-history-stash

`zudo-history-stash` is a small, git-shaped versioned text and binary store on Cloudflare Workers with rollback, diff, idempotent writes, and a standalone viewer. Its first consumer is a Slack-bot project that keeps an AI-updated, skill-like text layer: this service replaces the GitHub PR diff/approval/revert loop with HTTP history, reviewable change sets, and rollback while leaving approval policy to the consumer.

## Architecture

```text
consumers (Node.js, browser, Worker service binding)
                         │
                         ▼
                 stash Worker (/v1)
                   ├──► D1 (metadata, heads, history, and inline bytes)
                   └──► private R2 (larger immutable bytes)

viewer Worker ── service binding ──► stash Worker
```

| Package or Worker                                     | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@takazudo/zudo-history-stash-core` (`packages/core`) | Runtime-agnostic types, schemas, validators, hashes, limits, and diff engine |
| `@takazudo/zudo-history-stash` (`packages/client`)    | Node, browser, and Worker client with CAS writes and bounded retries         |
| `@takazudo/zudo-history-stash-ui` (`packages/ui`)     | Router-independent React workflows, hooks, and components                    |
| `zudo-history-stash` (`workers/stash`)                | Hono `/v1` API with D1 metadata/history and private R2 spill storage         |
| `zudo-history-stash-viewer` (`workers/viewer`)        | React/Tailwind standalone viewer and service-binding proxy                   |

Representation, access, transfer, and placement are independent decisions. A valid UTF-8 body
remains `text` at every supported size; being above 5,000,000 bytes does not make it `binary`.
Conversely, binary bytes can be small enough for D1. `contentAccess` (`inline`, `raw`, or
`deleted`) describes how a version can be read, while `transferMode` (`json`, `single`, or
`multipart`) describes how an upload moves, and `storageTier` (`d1` or `r2`) describes placement.
Diff eligibility is a separate 524,288-byte-per-side contract. See the [binary API contract](docs/api.md#limits-and-storage-tiers)
and [exact limits](docs/api.md#routes) before choosing a mode. Published defaults are
`JSON_INLINE_MAX_BYTES=5000000`, `D1_INLINE_MAX_BYTES=524288`, `HTTP_REQUEST_MAX_BYTES=100000000`,
`SINGLE_UPLOAD_MAX_BYTES=33554432`, `MAX_FILE_BYTES=100000000`, `DIFF_MAX_BYTES=524288`,
`MULTIPART_PART_BYTES=8388608`, eight open sessions, 500000000 reserved bytes per stash, and a
86400-second session TTL. `MAX_FILE_BYTES` may be raised to 1 GiB only with matching reservation
capacity and at most 10,000 parts; 1 GiB is a correctness ceiling, not a performance certification.

## Consumer guide

Install the isomorphic client in a Node.js application, browser bundle, or Worker:

```bash
pnpm add @takazudo/zudo-history-stash
```

The client returns typed business outcomes and keeps compare-and-set versions explicit:

```ts
import { createStashClient } from "@takazudo/zudo-history-stash";
const client = createStashClient({
  baseUrl: process.env.STASH_URL!,
  token: process.env.STASH_TOKEN,
});
const files = client.files("demo");
const put = await client.putLatest("demo", "docs/guide.md", "Updated guide\n");
if (!put.ok) throw new Error(put.error.message);
const history = await files.history("docs/guide.md");
if (!history.ok) throw new Error(history.error.message);
const diff = await files.diff("docs/guide.md", { from: 1, to: "head" });
if (!diff.ok) throw new Error(diff.error.message);
const rollback = await files.rollback("docs/guide.md", {
  toVersion: 1,
  expectedVersion: put.value.version,
});
if (!rollback.ok) throw new Error(rollback.error.message);
```

Use `commits.create` when multiple paths must move together. Every entry carries its own head fence;
the server either applies all entries or returns a failure with the fenced paths in root-level
`conflicts[]` and applies none. Exactly one failure whose current head is absent is `404 not-found`;
all other entry-fence failures are `409 commit-conflict`:

```ts
const commit = await client.commits("demo").create({
  entries: [
    {
      op: "put",
      path: "site/index.html",
      expectedVersion: null,
      body: "<!doctype html><link rel=\"stylesheet\" href=\"styles.css\">\n",
      contentType: "text/html",
    },
    {
      op: "put",
      path: "site/styles.css",
      expectedVersion: null,
      body: "body { font-family: system-ui; }\n",
      contentType: "text/css",
    },
  ],
  author: "site-builder",
  message: "Publish site shell",
});
if (!commit.ok) {
  if (commit.conflicts !== undefined) console.error(commit.conflicts);
  throw new Error(commit.error.message);
}
```

For review before publication, create an immutable change set, inspect its candidate diffs, then
approve or reject it. Approval rechecks every captured base and creates exactly one commit; it never
silently rebases a stale candidate:

```ts
const changeSets = client.changeSets("demo");
const created = await changeSets.create({
  entries: [
    {
      op: "put",
      path: "docs/guide.md",
      baseVersion: rollback.value.version,
      body: "Reviewed guide\n",
      contentType: "text/markdown",
    },
  ],
  author: "docs-bot",
  message: "Review guide refresh",
});
if (!created.ok) throw new Error(created.error.message);

const review = await changeSets.diff(created.value.id, { context: 3 });
if (!review.ok) throw new Error(review.error.message);
if (review.value.stale) throw new Error("Change set is stale; create a new review candidate");

const approved = await changeSets.approve(created.value.id, {
  author: "reviewer",
  message: "Approve guide refresh",
});
if (!approved.ok) throw new Error(approved.error.message);
console.log(approved.value.commit.id);
```

Raw uploads keep bytes unchanged and choose a transport from the server capabilities. This example
is binary even though it is smaller than the D1 threshold; a large UTF-8 `Blob` can instead be
uploaded with `representation: "text"`:

```ts
const png = await client.files("demo").upload("assets/logo.png", pngBlob, {
  expectedVersion: null,
  representation: "binary",
  contentType: "image/png",
  mode: "auto",
});
if (!png.ok) throw new Error(png.error.message);

const firstBytes = await client.files("demo").raw.get("assets/logo.png", {
  range: "bytes=0-1023",
});
if (firstBytes.ok && "value" in firstBytes) {
  console.log(await firstBytes.value.bytes(1024));
}
```

For a same-account Worker, prefer the named `StashRpc` entrypoint and the same client API:

```toml
compatibility_date = "2024-04-03"

[[services]]
binding = "STASH_RPC"
service = "zudo-history-stash"
entrypoint = "StashRpc"
```

```ts
import { createStashClient, type StashRpcEntrypoint } from "@takazudo/zudo-history-stash";

interface Env {
  STASH_RPC: StashRpcEntrypoint;
  STASH_TOKEN: string;
}

const client = createStashClient({
  transport: { kind: "rpc", binding: env.STASH_RPC, token: env.STASH_TOKEN },
});
```

The existing fetch service binding remains available for HTTP-compatible consumers. The hostname
is only a valid URL base; the binding routes the request internally:

```toml
[[services]]
binding = "STASH"
service = "zudo-history-stash"
```

```ts
const client = createStashClient({
  baseUrl: "https://stash.internal",
  token: env.STASH_TOKEN,
  fetch: (input, init) => env.STASH.fetch(input, init),
});
```

Bots and other consumers can post stable viewer links without knowing the viewer implementation:

- `/s/:stash/f/*path` opens a file and its history.
- `/s/:stash/diff/*path?from=N&to=M|head` opens a stored-version diff.
- `/s/:stash/edit/*path?from=N` opens the write-gated editor, optionally from an older version.
- `/s/:stash/new` opens the write-gated new-file form.
- `/s/:stash/tokens` opens admin-only token management for a stash.

Browser-direct code must use a `read` token. A `write` token is a full-stash credential and can
replace, delete, or roll back every path in that stash; keep it in a trusted server or Worker
secret. See the [UI package guide](packages/ui/README.md), complete [API reference](docs/api.md),
generated [OpenAPI document](docs/openapi.json), [Cloudflare setup guide](docs/cloudflare-setup.md),
and [Viewer operations runbook](docs/viewer-operations.md).

Once repository Cloudflare credentials are provisioned, same-repository pull requests receive
isolated stash and Viewer Workers plus D1, R2, and Worker-owned Durable Object resources, with
automatic close teardown and orphan reaping; see
[Cloudflare setup](docs/cloudflare-setup.md#pull-request-previews) and
[Testing](TESTING.md#pull-request-preview-lane).

## Quick start

```bash
pnpm install
cp workers/stash/.dev.vars.example workers/stash/.dev.vars
pnpm dev:full
```

`dev:full` builds the workspace libraries and viewer assets, applies pending local D1 migrations,
and then starts both Workers. The viewer is the first (primary) config and is exposed on
`http://localhost:8787`; the stash is an auxiliary Worker with no public local port and is reached
through the viewer's `STASH` service binding. The copied `.dev.vars` supplies the agreed local-only
`STASH_ADMIN_TOKEN=dev-admin-token` to the stash Worker.

In another terminal, wait for the proxied health marker and seed the deterministic fixture through
the viewer. The bare seed script defaults to `http://localhost:8787` for `dev:stash`; `seed:dev`
pins `API_BASE_URL=http://localhost:8787/api` for the full viewer-primary topology:

```bash
pnpm wait:full
pnpm seed:dev
```

The seed creates stash `demo`, writes three versions of `docs/guide.md` (including Japanese and
CRLF bodies), creates then deletes `notes/todo.txt`, and finally rolls the guide back to v1. It
prints its newly minted write token once for optional manual use; the viewer and tests use the
admin token and never depend on that printed value. A second run skips the existing `demo` stash.
To preserve the fixture while exercising a reset,
`node scripts/seed-dev.mjs --base-url http://localhost:8787/api --reset` uses a fresh
`demo-reset-...` stash because stash deletion is deferred.

## Lifecycle and GC confirmation

The final local proof is split deliberately: `pnpm b4push` covers the ordinary workspace, the
focused Worker test exercises isolated real D1/R2 storage with an injected clock, and the
server-backed lanes exercise `dev:full` without making a production mutation:

```bash
pnpm --filter zudo-history-stash exec vitest run \
  --config vitest.config.ts test/final-evidence.test.ts
pnpm b4push

# With dev:full running and demo seeded:
TEST_TIER=local API_BASE_URL=http://localhost:8787/api STASH_ADMIN_TOKEN=dev-admin-token \
  pnpm --filter zudo-history-stash test:contract
API_BASE_URL=http://localhost:8787/api STASH_ADMIN_TOKEN=dev-admin-token \
  node packages/client/scripts/conformance-live.mjs

# Stop the manual server first; Playwright owns a fresh dev:full lifecycle.
pnpm --filter zudo-history-stash-viewer e2e:live
```

The HTTP contract includes the complete spill → soft-delete → revoked-token → admin visibility →
restore → exact read → new-token lifecycle on a uniquely suffixed stash. The focused storage proof
covers R2 dry/live collection, ledger continuation, leases, run identity, history order, and
restart-after-completion. The browser GC smoke is always a dry run. See [TESTING.md](TESTING.md) for
the production-tier skip audit and exact safety boundaries.

See [docs/api.md](docs/api.md) for the API reference and
[docs/cloudflare-setup.md](docs/cloudflare-setup.md) for Cloudflare provisioning. Operators should
also read [docs/viewer-operations.md](docs/viewer-operations.md) before deploying the Viewer.

| Command                                | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `pnpm dev:stash`                       | Run the stash Worker locally                                      |
| `pnpm dev:viewer`                      | Run the Vite viewer locally                                       |
| `pnpm dev:migrate`                     | Apply pending migrations to the local stash D1                    |
| `pnpm dev:full`                        | Build, migrate, then run the viewer-primary multi-Worker topology |
| `pnpm wait:full` / `pnpm seed:dev`     | Wait for proxied health, then seed `demo` through `/api`          |
| `pnpm build:libs`                      | Build the three public packages first                             |
| `pnpm build:viewer`                    | Build static viewer assets for the full local Worker              |
| `pnpm build`                           | Build every workspace package and Worker dry-run                  |
| `pnpm test`                            | Run workspace unit/Worker tests                                   |
| `pnpm typecheck`                       | Type-check every workspace package                                |
| `pnpm lint` / `pnpm lint:tokens`       | Run ESLint and Viewer + UI package token lint                     |
| `pnpm format:check` / `pnpm format:md` | Check or format source and Markdown                               |
| `pnpm b4push`                          | Run the local pre-push quality sequence                           |

Cloudflare Artifacts is useful prior art, but it is closed beta, paid, and git-client-centric. History Stash deliberately avoids that "git is overkill" tradeoff: it keeps the D1-backed HTTP contract small and lets each consumer retain its own workflow.
