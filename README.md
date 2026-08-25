# zudo-history-stash

`zudo-history-stash` is a small, git-shaped versioned text store on Cloudflare Workers with rollback, diff, idempotent writes, and a standalone viewer. Its first consumer is a Slack-bot project that keeps an AI-updated, skill-like text layer: this service replaces the GitHub PR diff/approval/revert loop with an HTTP history and rollback API while leaving approval in the consumer.

## Architecture

```text
consumers (Node.js, browser, Worker service binding)
                         │
                         ▼
                 stash Worker (/v1)
                         │
                         ▼
                         D1

viewer Worker ── service binding ──► stash Worker
```

| Package or Worker                                     | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@takazudo/zudo-history-stash-core` (`packages/core`) | Runtime-agnostic types, schemas, validators, hashes, limits, and diff engine |
| `@takazudo/zudo-history-stash` (`packages/client`)    | Node, browser, and Worker client with CAS writes and bounded retries         |
| `zudo-history-stash` (`workers/stash`)                | Hono `/v1` API and the D1 system of record                                   |
| `zudo-history-stash-viewer` (`workers/viewer`)        | React/Tailwind standalone viewer and service-binding proxy                   |

## Quick start

```bash
pnpm install
pnpm dev:full
```

The full local setup serves the viewer on `http://localhost:8787` and reaches the stash Worker through the local service binding. Once the live harness exists, seed its deterministic fixture with:

```bash
node scripts/seed-dev.mjs --base-url http://localhost:8787/api
```

See [docs/api.md](docs/api.md) for the API reference stub (filled in by the contract/docs sub-issue) and [docs/cloudflare-setup.md](docs/cloudflare-setup.md) for Cloudflare provisioning.

| Command                                | Purpose                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `pnpm dev:stash`                       | Run the stash Worker locally                                       |
| `pnpm dev:viewer`                      | Run the Vite viewer locally                                        |
| `pnpm dev:full`                        | Run viewer plus stash with Wrangler's multi-config service binding |
| `pnpm build:libs`                      | Build the two public packages first                                |
| `pnpm build`                           | Build every workspace package and Worker dry-run                   |
| `pnpm test`                            | Run workspace unit/Worker tests                                    |
| `pnpm typecheck`                       | Type-check every workspace package                                 |
| `pnpm lint` / `pnpm lint:tokens`       | Run ESLint and viewer token lint                                   |
| `pnpm format:check` / `pnpm format:md` | Check or format source and Markdown                                |
| `pnpm b4push`                          | Run the local pre-push quality sequence                            |

Cloudflare Artifacts is useful prior art, but it is closed beta, paid, and git-client-centric. History Stash deliberately avoids that "git is overkill" tradeoff: it keeps the D1-backed HTTP contract small and lets each consumer retain its own workflow.
