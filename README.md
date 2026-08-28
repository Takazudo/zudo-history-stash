# zudo-history-stash

`zudo-history-stash` is a small, git-shaped versioned text store on Cloudflare Workers with rollback, diff, idempotent writes, and a standalone viewer. Its first consumer is a Slack-bot project that keeps an AI-updated, skill-like text layer: this service replaces the GitHub PR diff/approval/revert loop with an HTTP history and rollback API while leaving approval in the consumer.

## Architecture

```text
consumers (Node.js, browser, Worker service binding)
                         │
                         ▼
                 stash Worker (/v1)
                   ├──► D1 (metadata, heads, history, and inline text)
                   └──► private R2 (large text bodies)

viewer Worker ── service binding ──► stash Worker
```

| Package or Worker                                     | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@takazudo/zudo-history-stash-core` (`packages/core`) | Runtime-agnostic types, schemas, validators, hashes, limits, and diff engine |
| `@takazudo/zudo-history-stash` (`packages/client`)    | Node, browser, and Worker client with CAS writes and bounded retries         |
| `@takazudo/zudo-history-stash-ui` (`packages/ui`)     | Router-independent React workflows, hooks, and components                    |
| `zudo-history-stash` (`workers/stash`)                | Hono `/v1` API with D1 metadata/history and private R2 spill storage         |
| `zudo-history-stash-viewer` (`workers/viewer`)        | React/Tailwind standalone viewer and service-binding proxy                   |

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
- `/s/:stash/proposals?status=open|all&path=...` lists proposals, optionally filtered by path.
- `/s/:stash/proposals/:id` opens the immutable proposal review and decision record.
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
