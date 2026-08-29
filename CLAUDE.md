# zudo-history-stash

This repository is a Cloudflare-based, versioned text store with rollback, on-demand diff, and a standalone viewer. The authoritative architecture and testing contract is the [epic architecture contract](https://github.com/Takazudo/zudo-history-stash/issues/2#architecture-contract-shared-by-every-sub-issue).

## Development status

This project is pre-release work in progress with no users, no consumers, and no production data that must be preserved. Breaking changes are acceptable and expected: the HTTP contract, SDK API, viewer URL scheme, D1 schema, and stored data may be redesigned, migrated destructively, or reset when that is the clearest path. Do not design for backward compatibility, do not add compatibility facades, deprecation shims, or migration paths for existing rows, and do not wait for operator-acceptance gates whose only purpose is protecting existing data or mixed-version compatibility. Continue to protect credentials and account boundaries. This section is removed when the project is explicitly declared released.

## Tech stack

| Dependency                        | Why it is here                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Cloudflare Workers + Wrangler     | Globally deployed HTTP Workers and the committed deploy/config path                           |
| D1                                | One transactional, queryable system of record for append-only versions and mutable file heads |
| Hono                              | Small, typed Worker routing and middleware composition                                        |
| TypeScript                        | Strict contracts shared by the Workers, SDK, and viewer                                       |
| Zod                               | Runtime validation at HTTP boundaries, including strict request objects                       |
| `diff` / jsdiff 9                 | On-demand unified patches and structured hunks without storing derived diffs                  |
| React 19 + React Router           | Viewer UI and its stable URL scheme                                                           |
| Tailwind CSS v4                   | Token-led viewer styling with a small generated CSS surface                                   |
| Vitest + Cloudflare Vitest plugin | Node package tests and D1-backed Worker tests                                                 |
| Playwright                        | Chromium mock and live viewer-to-Worker integration lanes                                     |

## Commands and ports

Run `pnpm install` first. `pnpm dev:stash` starts the stash Worker; `pnpm dev:viewer` starts Vite; `pnpm dev:full` starts the viewer on port `8787` with the stash service binding. The live API health URL is `http://localhost:8787/api/v1/health`.

Quality commands are `pnpm build:libs`, `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:tokens`, `pnpm test`, and `pnpm build`. `pnpm b4push` runs a b4push/CI parity check and those checks in that order after a frozen install.

## Automation

Lefthook installs the repository hooks. The pre-push hook runs `scripts/run-b4push.sh`; `scripts/check-b4push-ci-parity.mjs` keeps its command order aligned with the CI quality sequence in `.github/workflows/ci.yml`. CI adds package `publint`/`attw` checks and a Playwright e2e job with mock and guarded `@live` lanes. Deploy workflows apply stash D1 migrations before deployment, scope Cloudflare secrets to Wrangler steps, and smoke-test the deployed endpoint.

## Testing

Read [TESTING.md](TESTING.md) before choosing a test level or running a browser lane. The testing contract defines the worker/SDK and viewer archetypes, L1–L5 levels, T0/T1 execution tiers, the three-lane backend rule, and the `@live` versus `@local-only` Playwright conventions.

## Traps

- Run `build:libs` before typecheck or test; workspace consumers resolve generated library output.
- In `wrangler.toml`, keep scalar keys above the first table; TOML table scope otherwise captures later keys.
- Bindings, vars, and secrets are not inherited into `[env.preview]`; routes are inherited, so set `routes = []` for preview when needed.
- Keep `[secrets]` declarations and CI-injected secret values separate from committed vars.
- Wrangler 4.125.0 accepts `[secrets] required = ["STASH_ADMIN_TOKEN"]` in `wrangler.toml`, including `[env.preview.secrets]`. `wrangler types --include-runtime=false` includes the secret in generated Env declarations, and `wrangler deploy --dry-run` succeeds. Keep the required-secret declarations and the Wrangler/Env drift test; no fallback startup assertion is needed.
- `@cloudflare/vitest-plugin` 1.0 isolates D1 per test file, not per test. Any file with stateful tests must reset application tables in `beforeEach` via `resetDatabase()`; do not assume a fresh database between `it()` blocks.
- In a D1 batch, every statement must carry the operation's fence and the head write must be last; `meta.changes === 1` is the only success verdict.
- History is immutable: never `UPDATE` or `DELETE` rows in `versions`.
- Do not add `node:*` imports to Workers. The smoke script is the deliberate exception required to send the browser navigation `Sec-Fetch-Mode` header.
- Never use `~` in paths; use an explicit absolute path or an environment variable.
