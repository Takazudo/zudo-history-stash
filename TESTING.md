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

Keep backend testing in three lanes:

1. **Local:** full destructive CRUD, seed-and-teardown, and error injection against an isolated local database.
2. **Preview/live:** contract shape, auth handshake, and read assertions against the deployment under test; only explicitly fenced disposable mutations are allowed.
3. **Production smoke:** read-only health and known-good reads; never mutate production data.

The smoke script is intentionally narrow: stash health must be `200` JSON with `ZHS_HEALTH_OK`; viewer navigation must be a browser-shaped request and return `200` HTML with a `<title>`. Provisioning-only connection errors may skip until `SMOKE_REQUIRE_LIVE=1`; HTTP or content-contract failures remain failures.

## Playwright conventions

Use Chromium and title tags: `@smoke`, `@live`, `@local-only`, and `@flaky` (a flaky tag requires a linked issue). Keep a console-error fixture enabled, use reduced motion, and do not use `waitForTimeout` or `networkidle`. Mock API calls with `page.route('**/api/**')` in the mock lane.

The CI `@live` lane starts `pnpm dev:full`, waits for `http://localhost:8787/api/v1/health`, runs `node scripts/seed-dev.mjs --base-url http://localhost:8787/api`, and then runs `--grep @live`. `@local-only` is reserved for cases that require a developer machine and is excluded from the CI lane. Upload traces and reports only on failure or cancellation.

## Composition ownership

Shared composition files are created by the scaffold and are not edited by feature work. Stash route modules mount through `src/app.ts` and `src/routes/index.ts`; D1 reads/writes compose through `src/d1/store.ts`. Viewer router composition imports the page placeholders. A feature replaces only its owned module and adds new files, so parallel branches do not collide.

## Negative assertions

Fixtures must prove absence as well as presence: refused CAS writes leave zero rows in every table, tombstones never expose a body as a live head, foreign stashes return 404 rather than 403, and errors never echo request bodies. For security and browser tests, assert that disallowed scope, malformed tokens, unsafe `next` URLs, stale heads, and missing markers fail closed. Reset global fetch stubs and mocks in `afterEach`.
