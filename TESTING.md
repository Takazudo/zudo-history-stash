# Testing contract

Start with the repository's `/test-wisdom` guidance when a new test does not fit an existing pattern. This project has two archetypes: the stash Worker plus SDK behaves like a tested npm library/CLI with an HTTP backend, while the viewer behaves like a monorepo app with React/DOM and browser boundaries.

## Levels and execution tiers

The levels are cumulative evidence, not interchangeable labels:

- **L1 — unit:** pure core/client behavior, validators, hashes, schemas, and deterministic helpers in Vitest/Node.
- **L2 — DOM/component:** viewer components and routes with Testing Library and a fake client.
- **L3 — build output:** package bundles, Worker dry-runs, generated assets, `publint`, and `attw` against the packed package.
- **L4 — browser e2e:** Chromium navigation, interaction, routing, and API composition through Playwright.
- **L5 — live/infrastructure:** a running Worker, D1 bindings, service binding proxy, deployed smoke endpoints, or another real external boundary.

T0 is the local `pnpm b4push` sequence: frozen install → `build:libs` → format check → typecheck → lint (including token lint) → tests → build (including both Wrangler dry-runs). T1 is CI: the same sequence plus `publint`/`attw` and the Playwright e2e job. No nightly tier is part of v1.

The resource rule keeps child work proportional: a sub-issue runs its own package's unit/Worker tests and typecheck; the full Playwright suite, both dry-run deploys, package publication checks, and live composition belong to CI and the confirm pass.

## Worker and backend tests

Worker tests use the Cloudflare Vitest plugin and apply migrations in setup. Exercise routes with `app.request(url, init, env, ctx)`, wait for the execution context, and assert D1 rows directly. Inject `now` and IDs for deterministic responses, and use the `onBeforeCommit` seam for a real two-writer race. A process-group reaper prevents orphaned workerd processes.

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

The health, identity, list, get, conditional-get, history, diff, and change-feed cases run
unchanged at every tier. Every persisting case is declared directly with
`it.runIf(MUTATION_ALLOWED)`, where `MUTATION_ALLOWED` is true only for `TEST_TIER=local`.
Preview and production therefore share the same read assertions while discovering mutation cases
as skipped. A `POST` candidate diff remains in the read lane because the route has read capability
and never persists its body.

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

To audit the production mutation fence, run the same seeded read suite with the JSON reporter and
inspect its skipped-test count; no test in `local-only HTTP mutation contract` may pass or fail:

```bash
TEST_TIER=production \
API_BASE_URL=https://stash.example.com \
STASH_ADMIN_TOKEN="$STASH_ADMIN_TOKEN" \
pnpm --filter zudo-history-stash test:contract --reporter=json \
  --outputFile=contract-production.json
```

CI runs the local contract command after the live fixture is seeded. That step stays guarded by
`hashFiles('scripts/seed-dev.mjs')` until the live-harness topic supplies the seed script.

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

The CI `@live` lane starts `pnpm dev:full`, waits for `http://localhost:8787/api/v1/health`, runs `node scripts/seed-dev.mjs --base-url http://localhost:8787/api`, and then runs `--grep @live`. `@local-only` is reserved for cases that require a developer machine and is excluded from the CI lane. Upload traces and reports only on failure or cancellation.

## Composition ownership

Shared composition files are created by the scaffold and are not edited by feature work. Stash route modules mount through `src/app.ts` and `src/routes/index.ts`; D1 reads/writes compose through `src/d1/store.ts`. Viewer router composition imports the page placeholders. A feature replaces only its owned module and adds new files, so parallel branches do not collide.

## Negative assertions

Fixtures must prove absence as well as presence: refused CAS writes leave zero rows in every table, tombstones never expose a body as a live head, foreign stashes return 404 rather than 403, and errors never echo request bodies. For security and browser tests, assert that disallowed scope, malformed tokens, unsafe `next` URLs, stale heads, and missing markers fail closed. Reset global fetch stubs and mocks in `afterEach`.
