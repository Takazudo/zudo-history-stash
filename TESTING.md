# Testing contract

Start with the repository's `/test-wisdom` guidance when a new test does not fit an existing pattern. This project has two archetypes: the stash Worker plus SDK behaves like a tested npm library/CLI with an HTTP backend, while the viewer behaves like a monorepo app with React/DOM and browser boundaries.

## Levels and execution tiers

The levels are cumulative evidence, not interchangeable labels:

- **L1 — unit:** pure core/client behavior, validators, hashes, schemas, and deterministic helpers in Vitest/Node.
- **L2 — DOM/component:** viewer components and routes with Testing Library and a fake client.
- **L3 — build output:** package bundles, Worker dry-runs, generated assets, `publint`, and `attw` against the packed package.
- **L4 — browser e2e:** Chromium navigation, interaction, routing, and API composition through Playwright.
- **L5 — live/infrastructure:** a running Worker, D1 bindings, service binding proxy, deployed smoke endpoints, or another real external boundary.

T0 is the local `pnpm b4push` sequence: frozen install → b4push/CI parity → `build:libs` → format check → typecheck → lint (including token lint) → tests → build (including both Wrangler dry-runs). T1 is CI: the same sequence plus `publint`/`attw` and the Playwright e2e job. No nightly tier is part of v1.

The resource rule keeps child work proportional: a sub-issue runs its own package's unit/Worker tests and typecheck; the full Playwright suite, both dry-run deploys, package publication checks, and live composition belong to CI and the confirm pass.

## Worker and backend tests

Worker tests use the Cloudflare Vitest plugin and apply migrations in setup. Exercise routes with `app.request(url, init, env, ctx)`, wait for the execution context, and assert D1 rows directly. Inject `now` and IDs for deterministic responses, and use the `onBeforeCommit` seam for a real two-writer race. A process-group reaper prevents orphaned workerd processes.

Authentication route tests inject the clock through `createApp({ now })`; token creation and
rotation store tests pass `now` through the store dependencies; the fake conformance adapter uses
`createFakeStash({ now })`. The RPC parity matrix freezes `Date.now()` before dispatch through the
default app. These seams test equality with `expires_at` as already expired without sleeping.

Rate-limit unit and RPC tests override only the relevant `RL_READ`, `RL_WRITE`, or `RL_DIFF`
binding with a Cloudflare-shaped fake whose `limit({ key })` call resolves to `{ success: false }`.
Use a stash principal because administrators are exempt, and use a rejecting fake separately to
prove limiter failures fail open. `createTestEnv()` supplies fresh allow-all bindings for
unspecified limiters, so denial state is never shared between transports or tests.

The raised payload contract is pinned in two places. Worker route tests use streamed ASCII JSON
fixtures to prove the raw 32 MiB request boundary without materializing a second decoded copy. RPC
parity uses one ASCII request string at a time and dispatches HTTP then RPC sequentially: an exact
5,000,000-byte file round-trips through R2, 5,000,001 bytes is `413 payload-too-large`, and a valid
aggregate import above 32 MiB is the same `413` on both transports. Every transport starts with a
fresh database and real workerd R2 bucket; rejection cases prove zero file/version/blob rows and
zero R2 reads or writes.

### `@cloudflare/vitest-plugin` 1.0 D1 isolation

Verified with two tests in the same test file inserting the same primary-key row: D1 storage is isolated per test file, not per individual test. The second test observes the first test's row and receives a UNIQUE-constraint failure. Stateful suites must call the shared `resetDatabase()` helper from `beforeEach`; migrations are applied once from `test/setup.ts` with `applyD1Migrations`.

Keep backend testing in three lanes:

1. **Local:** full destructive CRUD, seed-and-teardown, and error injection against an isolated local database.
2. **Preview/live:** contract shape, auth handshake, and read assertions against the deployment under test; only explicitly fenced disposable mutations are allowed.
3. **Production smoke:** read-only health and known-good reads; never mutate production data.

## HTTP contract suite

`workers/stash/test/contract` is a plain Node Vitest suite against a running HTTP origin. It uses
`@takazudo/zudo-history-stash` and is deliberately excluded from `pnpm test`, because unit tests
must not depend on a server.

| Variable              | Default                      | Purpose                                                            |
| --------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `API_BASE_URL`        | `http://localhost:8787`      | Stash API origin; use `http://localhost:8787/api` under `dev:full` |
| `TEST_TIER`           | `local`                      | `local`, `preview`, or `production`                                |
| `STASH_ADMIN_TOKEN`   | `dev-admin-token` on `local` | Credential for `/v1/me`, seeded reads, and local fixture creation  |
| `CONTRACT_STASH_NAME` | `demo`                       | Known seeded stash for read-only assertions                        |
| `CONTRACT_FILE_PATH`  | `docs/guide.md`              | Known seeded file with at least two versions                       |

The health, identity, list, get, conditional-get, history, diff, change-feed, and live-events
cases run unchanged at every tier. The live assertion opens the seeded stash's `/events` stream,
requires a validated `ready` event within an explicit five-second watchdog, and always aborts the
stream in `finally` before proving the SDK status is `closed`. It is unconditional: an unavailable,
buffered, or non-streaming events route fails the read contract instead of becoming a skipped test.
Every persisting case is declared directly with
`it.runIf(MUTATION_ALLOWED)`, where `MUTATION_ALLOWED` is true only for `TEST_TIER=local`.
Preview and production therefore share the same read assertions while discovering mutation cases
as skipped. A `POST` candidate diff remains in the read lane because the route has read capability
and never persists its body. The local mutation lane is additionally fenced to a loopback
`API_BASE_URL`; setting `TEST_TIER=local` for a remote origin leaves every persisting case skipped.

The local-only mutation lane also mints a token with `ttlSeconds: 1` and proves it becomes the
public `401 unauthorized`, then rotates a separate token and proves both credentials during the
grace period, the second `409 already-rotated` response, and predecessor expiry while the successor
remains usable. These cases intentionally use the running Worker's real clock and bindings plus
unique stash/token keys. Every boundary wait is derived from the expiry timestamp returned by the
Worker, with a small post-boundary margin, rather than from a guessed fixed delay.

The same local-only lane creates a unique 1.5 MB ASCII file and drives the full spilled-body
lifecycle: PUT, a small successor, metadata-only history, byte-oversized diff, rollback to the
original hash, exact GET body, and conditional `304`. Because the stash name is unique, rerunning
the contract against persisted local D1/R2 state does not depend on or overwrite an earlier run.
It also creates a separate unique stash and write token, spills a 1.5 MB body, soft-deletes the
stash, proves the former token is `401`, finds the record only with `includeDeleted`, restores it,
reads the exact body as admin, proves the old token remains revoked, and authenticates a new token.

The injected-clock Worker/RPC tests and fake conformance trace run inside the ordinary workspace
test lane. The server-backed HTTP contract, checked-in live conformance runner, and Playwright live
suite are separate evidence lanes. `pnpm b4push` includes the ordinary workspace tests but does not
start a Worker or transitively run those server-backed gates; record each one independently.

Against `pnpm dev:stash` plus the seeded fixture:

```bash
TEST_TIER=local \
API_BASE_URL=http://localhost:8787 \
pnpm --filter zudo-history-stash test:contract
```

Under `pnpm dev:full`, point through the viewer proxy:

```bash
TEST_TIER=local \
API_BASE_URL=http://localhost:8787/api \
pnpm --filter zudo-history-stash test:contract
```

To audit the production mutation fence without contacting production, point the production tier at
the seeded local `dev:full` origin with the JSON reporter and inspect its skipped-test count; no test
in `local-only HTTP mutation contract` may pass or fail:

```bash
TEST_TIER=production \
API_BASE_URL=http://localhost:8787/api \
STASH_ADMIN_TOKEN=dev-admin-token \
pnpm --filter zudo-history-stash test:contract --reporter=json \
  --outputFile=/tmp/zhs-contract-production.json
```

This command performs only the cross-tier read contract. A real production smoke remains the
read-only health/auth check described below; never use the local mutation or live conformance lane
against a deployed production origin.

CI runs the local contract command after the live fixture is seeded through the viewer proxy. The
guard used while the harness was being built is gone, so the contract suite is now a required part
of every `e2e` job.

## SDK conformance trace

The client package exports one data-driven trace from `@takazudo/zudo-history-stash/testing`. Its
unit lane runs against `createFakeStash`; the checked-in live runner executes the same expiry,
one-shot rotation, rate-limit, auth, and file/history scenarios against a running Worker. Start
`pnpm dev:full` in one terminal, then run:

```bash
pnpm build:libs
API_BASE_URL=http://localhost:8787/api \
STASH_ADMIN_TOKEN=dev-admin-token \
node packages/client/scripts/conformance-live.mjs
```

The runner creates a unique stash unless `CONFORMANCE_STASH_NAME` is set. To reach the configured
local `RL_WRITE` boundary without persisting probe data, it charges the write principal with a
schema-invalid request until Wrangler returns 429, then verifies the trace request receives
`Retry-After: 60`. Missing environment variables, an unavailable limiter, or any trace mismatch
prints the failing step and exits nonzero. This is deliberately a mutating, loopback-only runner:
it rejects non-local tiers and non-loopback origins. Both GC operations in its shared trace are
hard-coded dry runs.

## Lifecycle and GC confirmation matrix

The aggregate confirmation keeps destructive storage proof inside isolated Cloudflare test
bindings and live product proof on `dev:full`:

```bash
pnpm --filter zudo-history-stash exec vitest run \
  --config vitest.config.ts test/final-evidence.test.ts
pnpm b4push
```

The focused Worker proof uses real isolated D1/R2 bindings. It derives the injected GC clock from
the R2 objects' own upload timestamps, then proves referenced, orphan v2, and legacy-key handling;
ledger ties and continuation; cursor persistence; public `409 gc-busy`; stable job IDs; distinct
UUID run IDs; newest-first history; and restart after a null cursor. It does not edit local Wrangler
state or wait out the 15-minute age gate.

With `dev:full` running and `demo` seeded, record these as separate stash lanes:

```bash
TEST_TIER=local \
API_BASE_URL=http://localhost:8787/api \
STASH_ADMIN_TOKEN=dev-admin-token \
pnpm --filter zudo-history-stash test:contract

API_BASE_URL=http://localhost:8787/api \
STASH_ADMIN_TOKEN=dev-admin-token \
node packages/client/scripts/conformance-live.mjs
```

Stop that manually managed server before the one-command viewer lane. Automation environments
should serialize this browser lane with their normal Playwright guard:

```bash
pnpm --filter zudo-history-stash-viewer e2e:live
```

The live browser cases soft-delete and restore a unique stash, and submit an R2 GC page with
`dryRun: true`. They never delete `demo`, never submit live GC, never print token secrets or R2
object keys, and do not capture or upload screenshots. Both Playwright configuration and the live
spec reject a non-loopback `PW_BASE_URL` before the suite can send a request.

## Smoke tests

The post-deploy script is intentionally narrow and read-only:

- `node scripts/smoke.mjs --target stash` requires `200` JSON with `ZHS_HEALTH_OK`, then verifies
  that an unauthenticated `/v1/stashes` request returns `401`.
- `node scripts/smoke.mjs --target viewer` sends browser navigation headers to `/login`, requires
  `200` HTML with a `<title>`, then verifies that `/api/v1/health` proxies `200` with the stash
  marker.

Set `SMOKE_BASE_URL`, or the target-specific `STASH_BASE_URL` / `VIEWER_BASE_URL`. Provisioning-only
connection errors may skip until `SMOKE_REQUIRE_LIVE=1`; HTTP, TLS-expiry, and content-contract
failures remain failures. Once either request receives an HTTP response, later connection errors
in that run cannot be reclassified as provisioning skips.

## Playwright conventions

Use Chromium and title tags: `@smoke`, `@live`, `@local-only`, and `@flaky` (a flaky tag requires a linked issue). Keep a console-error fixture enabled, use reduced motion, and do not use `waitForTimeout` or `networkidle`. Mock API calls with `page.route('**/api/**')` in the mock lane.

### Pull-request preview lane

The pull-request preview is a real, isolated deployed L5 boundary. It is wiring evidence for the
same read contract, not a replacement for unit/local tests, and it must never target production.
Only same-repository PRs receive this lane; the workflow supplies its generated per-deployment
admin credential without publishing it.

Provisioning seeds the disposable `demo` stash through the Viewer proxy:

```bash
node scripts/seed-dev.mjs --base-url '<viewer>/api' --ci
```

`--ci` changes disclosure only: it suppresses the newly minted write-token log while preserving
the same API calls, failure behavior, and idempotent existing-stash path. It is not permission to
seed shared or production data. The workflow then runs the HTTP contract with
`TEST_TIER=preview`, `API_BASE_URL=<viewer>/api`, and the generated admin token. The cross-tier
health, identity, read, history, diff, change-feed, and SSE assertions run; every persisting case
remains skipped by the existing tier fence. The one seed is acceptable because the complete
per-PR database is isolated and disposable.

Browser proof is opt-in through the `chromium-preview` project and its single `@preview` test in
`preview.smoke.spec.ts`. It requires an external HTTPS `PW_BASE_URL` and the masked, generated
stash-scoped read token in `PW_STASH_TOKEN`. The test uses real API and SSE traffic with the strict
console-error fixture and no request mocks; it verifies the seeded guide and history and proves
that edit/delete controls are absent while rollback controls are disabled. The default `chromium`
mock project and `chromium-live` project both exclude this file and collect zero `@preview` tests.
Missing or invalid preview URL/token configuration fails before collection instead of skipping
green.

To inspect the preview selection locally without starting a browser or contacting the example
origin:

```bash
PW_PREVIEW=1 \
PW_BASE_URL=https://viewer.example.invalid \
PW_STASH_TOKEN=zhs_fixture \
pnpm --filter zudo-history-stash-viewer exec playwright test \
  --list --project=chromium-preview
```

This selects exactly one test in one file. Ordinary `pnpm b4push` includes the committed Worker
build dry-runs, but it does not run this remote preview lane, the separately pinned
actionlint/ShellCheck workflow gate, or the explicit PR-999 proof that generates both flattened
configs and passes each to repository-pinned
[Wrangler with `deploy --dry-run`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy).
Record those lanes independently; see
[Cloudflare setup](docs/cloudflare-setup.md#pull-request-previews).

### Local live topology and fixture

Copy `workers/stash/.dev.vars.example` to `workers/stash/.dev.vars` before starting local Workers.
The local convention is always:

- `STASH_ADMIN_TOKEN=dev-admin-token`
- viewer primary at `http://localhost:8787`
- stash auxiliary reachable only through the `STASH` service binding
- `API_BASE_URL=http://localhost:8787/api` for the seed and HTTP contract suite

`pnpm dev:full` builds the libraries and viewer assets, applies local D1 migrations, and passes the
viewer config first to Wrangler. Wrangler serves the viewer at `http://localhost:8787`, dispatches
`/api/v1/*` through its `STASH` service binding to the stash Worker in the same local runtime, and
instantiates the SQLite-backed `StashEvents` Durable Object from the stash config. The object has no
application storage; the migration declares its namespace, while D1 remains the authoritative
change feed. Keep the combined Wrangler process alive for an SSE session—running only Vite or only
the stash Worker does not reproduce the viewer proxy + service binding + local DO topology.
`pnpm wait:full` polls `/api/v1/health` until it sees the `ZHS_HEALTH_OK` marker. `pnpm seed:dev` then
creates the `demo` fixture. The base seed is idempotent:
it skips an existing `demo`; `--reset` creates a fresh suffixed stash because deletion is deferred.
A successful new seed prints its write token exactly once, but no test or follow-up command
consumes that output. The bare script's `http://localhost:8787` default is for `dev:stash`; always
use the `/api` base URL above with `dev:full`.

Add the deterministic 1.5 MB R2-backed fixture independently of whether `demo` already exists:

```bash
STASH_ADMIN_TOKEN=dev-admin-token \
  API_BASE_URL=http://localhost:8787/api \
  node scripts/seed-dev.mjs --base-url http://localhost:8787/api --large
```

`--large` reserves `fixtures/r2-large.txt`. It creates the file when absent, skips only when the
existing body, byte count, and SHA-256 hash match exactly, and fails instead of overwriting a
mismatched or tombstoned history. `--reset --large` creates both fixtures in a fresh suffixed stash.
`dev:full` passes `--persist-to .wrangler/state`, so stopping it and starting it again with the same
working tree preserves both local D1 pointers and R2 objects; do not remove that state between the
two halves of a persistence proof.

The one-command browser lane lets Playwright own this same start → marker wait → seed lifecycle:

```bash
pnpm --filter zudo-history-stash-viewer e2e:live
```

For a manual reproduction with the server kept in a separate terminal, use:

```bash
# Terminal 1
STASH_ADMIN_TOKEN=dev-admin-token pnpm dev:full

# Terminal 2
HEALTH_URL=http://localhost:8787/api/v1/health node scripts/wait-for.mjs
STASH_ADMIN_TOKEN=dev-admin-token \
  API_BASE_URL=http://localhost:8787/api \
  node scripts/seed-dev.mjs --base-url http://localhost:8787/api --large
PW_BASE_URL=http://localhost:8787 \
  STASH_ADMIN_TOKEN=dev-admin-token \
  pnpm --filter zudo-history-stash-viewer e2e:live
```

The Chromium mock lane verifies the 1.5 MB body without copying it back through Playwright: browser
code reports its UTF-8 length and SHA-256 digest. At mobile, tablet, and desktop widths it requires
`html`, `body`, and `.page__scroll` to remain horizontally contained while `.file-body-pane` owns
the long-line overflow; it also renders the byte-oversized diff card and both resolved raw-version
links. Run only that deterministic browser case with:

```bash
pnpm --filter zudo-history-stash-viewer e2e --project=chromium --grep "1.5 MB file"
```

The guarded `chromium-live` lane separately writes the same fixed body through the viewer's
relative `/api` proxy using a uniquely labelled write token and unique file path, reads the exact
body back, then tombstones the file and revokes the token in `finally`. That cleanup is deliberately
described as **logical**: immutable D1 history and content-addressed R2 bytes may remain. Run the
full live lane only with its managed `dev:full` lifecycle or the two-terminal command above.

The same lane also owns the real live-refresh proof. It seeds a known tab client ID, proves a unique
path is absent, observes a `200 text/event-stream` connection and the `Live` header indicator,
waits for the ready-triggered authoritative change-feed reconciliation, and then creates the path
with a different `X-Stash-Client-Id`. The post-mutation `/changes?since=...` response must contain
that path and the file row must become visible before a deadline strictly below
`VIEWER_LIVE_POLL_INTERVAL_MS`. Do not replace this with a zero-change-feed assertion: live events
are advisory and that fetch is the correctness boundary. Mock Playwright suites instead receive a
shared open, abort-bound SSE shim with no fabricated `ready`; the `@live` project opts out and must
always reach the real Worker stream.

The live rollback replay proof deliberately retries **without closing the dialog**. The first
request commits in the real stash Worker, while Playwright aborts its browser-facing response.
Clicking `Try again` in that still-mounted dialog reuses both the request body and its
`Idempotency-Key`; the test requires `Idempotent-Replayed: true` and verifies that D1 contains only
one new version (v5 on a fresh fixture). Closing and reopening would mount a new dialog and mint a
new key, so a second rollback would be valid behavior rather than an idempotent replay.

CI starts `pnpm dev:full` in its own process group, validates the proxied health marker, seeds with
the same token and `/api` base URL, runs the guarded HTTP contract step from issue #21, and then runs
the `chromium-live` project. It always stops the full Worker process group. The live project retains
traces on failure, and CI uploads its Playwright results, HTML report, and Worker log on failure or
cancellation. `@local-only` remains reserved for specs that require a developer machine and is
excluded from CI.

## Composition ownership

Shared composition files are created by the scaffold and are not edited by feature work. Stash route modules mount through `src/app.ts` and `src/routes/index.ts`; D1 reads/writes compose through `src/d1/store.ts`. Viewer router composition imports the page placeholders. A feature replaces only its owned module and adds new files, so parallel branches do not collide.

## Negative assertions

Fixtures must prove absence as well as presence: refused CAS writes leave zero rows in every table, tombstones never expose a body as a live head, foreign stashes return 404 rather than 403, and errors never echo request bodies. For security and browser tests, assert that disallowed scope, malformed tokens, unsafe `next` URLs, stale heads, and missing markers fail closed. Reset global fetch stubs and mocks in `afterEach`.
